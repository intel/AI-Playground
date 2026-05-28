"""
Home Agent Backend - thin proxy forwarding /v1/chat/completions to llamaCPP / OpenVINO.

Telegram bot polls for incoming messages and queues them for Electron to pick up.
"""

import argparse
import asyncio
import hmac
import logging
import os
import re
import threading
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS
from llm_proxy import proxy_chat_completions

app = Flask(__name__)
CORS(app)

# ── Loopback auth ─────────────────────────────────────────────────────────────
# The Flask server binds to 127.0.0.1, but on a shared host (multi-user box,
# host-networked containers, low-IL processes) any local peer can still reach
# our port. Require an `X-AIPG-Auth` header that matches the per-launch token
# the Electron main process injected via env. Mirrors the pattern used by the
# `ai-backend` Flask service.
_LOOPBACK_AUTH_TOKEN = os.environ.get("AIPG_LOOPBACK_TOKEN", "")
_LOOPBACK_REMOTE_ADDRS = frozenset({"127.0.0.1", "::1"})
# `/healthy` must remain reachable so the service registry can probe readiness
# before it has obtained the token.
_AUTH_EXEMPT_PATHS = frozenset({"/healthy"})


@app.before_request
def _enforce_loopback_and_auth():
    if request.remote_addr not in _LOOPBACK_REMOTE_ADDRS:
        return jsonify({"error": "loopback only"}), 403
    # CORS preflights do not carry custom headers by design — let flask-cors
    # handle them in the after_request stage.
    if request.method == "OPTIONS":
        return None
    if request.path in _AUTH_EXEMPT_PATHS:
        return None
    if not _LOOPBACK_AUTH_TOKEN:
        # Service was not provisioned with a token — reject everything except
        # the health probe to avoid serving unauthenticated traffic.
        return jsonify({"error": "service not provisioned"}), 503
    provided = request.headers.get("X-AIPG-Auth", "")
    if not provided or not hmac.compare_digest(provided, _LOOPBACK_AUTH_TOKEN):
        return jsonify({"error": "unauthorized"}), 401
    return None

# ── Log redaction ─────────────────────────────────────────────────────────────
# Telegram bot tokens look like "<numeric_id>:<base64-ish>" and appear in httpx
# request URLs (e.g. https://api.telegram.org/bot<token>/getUpdates). Strip them
# from every LogRecord at creation, so all child loggers (httpx, telegram.ext,
# werkzeug, …) emit redacted records regardless of where their handlers live.

# Token shapes we redact from logs:
# - Telegram: `<numeric_id>:<base64-ish>` (no word boundary on the digit side —
#   tokens embed inside URLs like `…/bot<id>:<token>/…`).
# - Slack bot token: `xoxb-...`.
# - Slack app-level token: `xapp-...`.
_TELEGRAM_TOKEN_RE = re.compile(r"\d{6,}:[A-Za-z0-9_-]{20,}")
_SLACK_TOKEN_RE = re.compile(r"xox[abporsb]-[A-Za-z0-9-]{10,}|xapp-\d+-[A-Za-z0-9-]{20,}")
_REDACTION = "<TOKEN_REDACTED>"


def _redact_one(value: str) -> str:
    return _SLACK_TOKEN_RE.sub(_REDACTION, _TELEGRAM_TOKEN_RE.sub(_REDACTION, value))


def _redact_token(value: object) -> object:
    if isinstance(value, str):
        return _redact_one(value)
    return value


class _PollAccessFilter(logging.Filter):
    """Suppress werkzeug access-log lines for the high-frequency poll endpoints."""

    _NOISY_PATHS = ("/poll-telegram", "/poll-slack")

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True
        return not any(path in message for path in self._NOISY_PATHS)


def _install_log_redaction() -> None:
    if getattr(logging, "_aipg_redaction_installed", False):
        return

    base_factory = logging.getLogRecordFactory()

    def _redacting_factory(*args, **kwargs):  # type: ignore[no-untyped-def]
        record = base_factory(*args, **kwargs)
        if isinstance(record.msg, str):
            record.msg = _redact_one(record.msg)
        if record.args:
            if isinstance(record.args, tuple):
                record.args = tuple(_redact_token(a) for a in record.args)
            elif isinstance(record.args, dict):
                record.args = {k: _redact_token(v) for k, v in record.args.items()}
        return record

    logging.setLogRecordFactory(_redacting_factory)
    # httpx / aiohttp / slack_sdk all log full URLs and request lines at INFO;
    # demote to WARNING so token-bearing strings stay out of the default volume.
    # The factory still scrubs anything that leaks at higher levels.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    logging.getLogger("aiohttp.client").setLevel(logging.WARNING)
    logging.getLogger("slack_sdk.web.async_base_client").setLevel(logging.WARNING)
    # Electron polls /poll-telegram and /poll-slack on a tight interval, which
    # otherwise fills the console with werkzeug access lines. Drop those
    # specific records while leaving every other request log intact.
    logging.getLogger("werkzeug").addFilter(_PollAccessFilter())
    logging._aipg_redaction_installed = True  # type: ignore[attr-defined]

# Upstream LLM URL
_upstream_url: str | None = None
_upstream_lock = threading.Lock()

# Telegram state
_pending_messages: list[dict] = []
_pending_lock = threading.Lock()

# Running bot instance + its event loop (set inside _start_telegram_bot)
_bot_application = None  # None | sentinel str "starting" | Application
_bot_loop: asyncio.AbstractEventLoop | None = None
_bot_token: str = ""
_bot_chat_id: str = ""
_bot_start_lock = threading.Lock()
# Set inside _start_telegram_bot.run(); awaited there to keep the bot alive.
# Triggering it from another thread (via call_soon_threadsafe) requests a
# graceful shutdown so a new token/chat_id can be applied without restarting
# the Flask process.
_bot_shutdown_event: asyncio.Event | None = None
_bot_thread: threading.Thread | None = None

# Persistent chat ID file — survives restarts
_CHAT_ID_FILE = Path(__file__).parent / ".chat_id"
_last_seen_chat_id: str | None = None
# Allowed chat for queueing + outbound sends (mutable after /set-telegram-token)
_allowed_chat_id: str = ""

# ── Slack state ───────────────────────────────────────────────────────────────
# Slack runs in its own asyncio thread paralleling the Telegram bot. The two
# never share state; both feed the renderer through their own
# poll/flush/send-* endpoints. Socket Mode only — desktop apps cannot host the
# inbound HTTPS endpoint required by HTTP Request URL mode.
_slack_pending_messages: list[dict] = []
_slack_pending_lock = threading.Lock()

# `_slack_app_instance` mirrors `_bot_application`: None | "starting" | AsyncApp
_slack_app_instance = None  # None | sentinel str "starting" | AsyncApp
_slack_loop: asyncio.AbstractEventLoop | None = None
_slack_bot_token: str = ""
_slack_app_token: str = ""
# DM partner whose messages we route through the renderer. Mutable after
# /set-slack-tokens. Empty string while in "detection mode" (first DM populates
# `_last_seen_slack_user_id`).
_allowed_slack_user_id: str = ""
# Cached IM channel id for outbound `chat.postMessage`. Resolved on first
# inbound DM and reused; if missing, sends fall back to user_id (Slack accepts
# both forms for `chat.postMessage`).
_slack_im_channel: str = ""
_slack_start_lock = threading.Lock()
_slack_shutdown_event: asyncio.Event | None = None
_slack_thread: threading.Thread | None = None

_SLACK_USER_ID_FILE = Path(__file__).parent / ".slack_user_id"
_last_seen_slack_user_id: str | None = None

logger = logging.getLogger(__name__)


def _load_persisted_chat_id() -> str | None:
    try:
        return _CHAT_ID_FILE.read_text().strip() or None
    except FileNotFoundError:
        return None


def _persist_chat_id(chat_id: str) -> None:
    try:
        _CHAT_ID_FILE.write_text(chat_id)
        logger.info("Persisted chat_id=%s to %s", chat_id, _CHAT_ID_FILE)
    except Exception as exc:
        logger.warning("Could not persist chat_id: %s", exc)


def _record_authorized_chat_id(chat_id: str) -> None:
    """Update `_last_seen_chat_id` + persist on disk only when the incoming
    chat is authorized.

    Authorized means either (a) detection mode is still active
    (`_allowed_chat_id` is empty, so `/get-chat-id` can return the first chat
    that messages the bot during setup) or (b) the chat matches the configured
    allow id. Without this guard, an unrelated user who messages the bot could
    overwrite `.chat_id` and confuse `/get-chat-id` / `_outbound_chat_id`.
    """
    global _last_seen_chat_id
    allow = _allowed_chat_id
    if allow and chat_id != allow:
        return
    if _last_seen_chat_id != chat_id:
        _last_seen_chat_id = chat_id
        _persist_chat_id(chat_id)


# Load persisted chat ID at startup
_last_seen_chat_id = _load_persisted_chat_id()


def _load_persisted_slack_user_id() -> str | None:
    try:
        return _SLACK_USER_ID_FILE.read_text().strip() or None
    except FileNotFoundError:
        return None


def _persist_slack_user_id(user_id: str) -> None:
    try:
        _SLACK_USER_ID_FILE.write_text(user_id)
        logger.info("Persisted slack user_id=%s to %s", user_id, _SLACK_USER_ID_FILE)
    except Exception as exc:
        logger.warning("Could not persist slack user_id: %s", exc)


# Load persisted Slack user ID at startup so detection survives restarts.
_last_seen_slack_user_id = _load_persisted_slack_user_id()


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/healthy")
def healthy():
    return jsonify({"status": "ok"})


# ── Upstream control ──────────────────────────────────────────────────────────

@app.post("/set-upstream")
def set_upstream():
    global _upstream_url
    data = request.get_json(silent=True) or {}
    url = data.get("url")
    if not url:
        return jsonify({"error": "url is required"}), 400
    with _upstream_lock:
        _upstream_url = url.rstrip("/")
    return jsonify({"status": "ok", "upstream": _upstream_url})


# ── Telegram polling control ──────────────────────────────────────────────────

@app.post("/set-telegram-token")
def set_telegram_token():
    """Inject bot token at runtime to start the polling bot without restart.

    If a bot is already running with a different token, gracefully stop it and
    start a new one so reconfiguration takes effect without a Flask restart.
    """
    global _bot_application, _allowed_chat_id, _bot_chat_id, _bot_thread
    data = request.get_json(silent=True) or {}
    token = data.get("token", "").strip()
    raw_chat = data.get("chatId")
    cleaned_chat = str(raw_chat).strip() if raw_chat is not None and str(raw_chat).strip() else ""
    if not token:
        return jsonify({"error": "token required"}), 400

    thread_to_join: threading.Thread | None = None
    with _bot_start_lock:
        if _bot_application == "starting":
            return jsonify({"status": "starting"}), 409
        if _bot_application is not None:
            if _bot_token == token:
                # Same token — just apply chat id so incoming messages are queued.
                # Without this, users stay stuck in detection mode forever after
                # Detect + verify.
                if cleaned_chat:
                    _allowed_chat_id = cleaned_chat
                    _bot_chat_id = cleaned_chat
                    logger.info(
                        "Telegram bot already running — applied chat_id=%s", cleaned_chat
                    )
                return jsonify({"status": "already_running", "chatUpdated": bool(cleaned_chat)})
            # Token changed — request graceful shutdown and restart with the new token.
            logger.info("Telegram bot token changed — restarting bot")
            loop = _bot_loop
            ev = _bot_shutdown_event
            if loop is not None and ev is not None:
                try:
                    loop.call_soon_threadsafe(ev.set)
                except Exception as exc:
                    logger.warning("Could not signal bot shutdown: %s", exc)
            thread_to_join = _bot_thread
        _bot_application = "starting"  # sentinel: blocks concurrent requests

    # Wait for old bot thread to finish outside the lock (best-effort, bounded).
    if thread_to_join is not None and thread_to_join.is_alive():
        thread_to_join.join(timeout=10)
        if thread_to_join.is_alive():
            logger.warning("Previous Telegram bot thread did not exit within 10s")

    t = threading.Thread(target=_start_telegram_bot, args=(token, cleaned_chat), daemon=True)
    _bot_thread = t
    t.start()
    logger.info("Started Telegram bot via /set-telegram-token")
    return jsonify({"status": "started"})


# ── Chat ID detection ─────────────────────────────────────────────────────────

@app.get("/get-chat-id")
def get_chat_id():
    """Return the last chat ID seen by the bot (from memory or persisted file)."""
    chat_id = _last_seen_chat_id or _load_persisted_chat_id()
    if chat_id:
        return jsonify({"chatId": chat_id})
    return jsonify({"error": "No chat ID detected yet. Send any message to your bot, then click Detect."}), 404


# ── Telegram queue ────────────────────────────────────────────────────────────

@app.get("/poll-telegram")
def poll_telegram():
    """Return and clear all pending Telegram messages."""
    with _pending_lock:
        msgs = list(_pending_messages)
        _pending_messages.clear()
    return jsonify(msgs)


@app.post("/flush-pending")
def flush_pending():
    """Discard all pending messages without processing them (used after chat-ID detection)."""
    with _pending_lock:
        count = len(_pending_messages)
        _pending_messages.clear()
    logger.info("flush-pending: discarded %d messages", count)
    return jsonify({"flushed": count})


def _outbound_chat_id() -> str | None:
    """Chat id to use for outbound Telegram API calls."""
    global _bot_chat_id, _allowed_chat_id, _last_seen_chat_id
    for cid in (_bot_chat_id, _allowed_chat_id, _last_seen_chat_id):
        if cid and str(cid).strip():
            return str(cid).strip()
    return None


@app.post("/send-telegram-reply")
def send_telegram_reply():
    """Send a reply text back to Telegram. Body: { text: str, parse_mode?: str }"""
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    parse_mode = data.get("parse_mode") or None
    target = _outbound_chat_id()
    if not _bot_application or _bot_application == "starting" or not _bot_loop or not target:
        return jsonify({"error": "Telegram not configured"}), 400
    try:
        future = asyncio.run_coroutine_threadsafe(
            _bot_application.bot.send_message(chat_id=target, text=text, parse_mode=parse_mode),
            _bot_loop,
        )
        future.result(timeout=10)
        return jsonify({"status": "ok"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/send-telegram-photo")
def send_telegram_photo():
    """Send a photo back to Telegram. Body: { photo: <base64 str>, caption: str }"""
    import base64
    data = request.get_json(silent=True) or {}
    photo_b64 = data.get("photo", "")
    caption = data.get("caption", "")
    target = _outbound_chat_id()
    if not _bot_application or _bot_application == "starting" or not _bot_loop or not target:
        return jsonify({"error": "Telegram not configured"}), 400
    try:
        photo_bytes = base64.b64decode(photo_b64)
        future = asyncio.run_coroutine_threadsafe(
            _bot_application.bot.send_photo(
                chat_id=target,
                photo=photo_bytes,
                caption=caption or None,
            ),
            _bot_loop,
        )
        future.result(timeout=120)
        return jsonify({"status": "ok"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/send-telegram-draft")
def send_telegram_draft():
    """Stream a partial message via Telegram's sendMessageDraft.

    Body: { draft_id: int (required, non-zero), text?: str, parse_mode?: str }

    Drafts with the same `draft_id` animate in place on the Telegram client. Each
    draft is ephemeral for ~30 seconds — callers must either re-issue this call
    (keep-alive) or finalize with `/send-telegram-reply` before the window
    expires. Drafts target private chats only; we use the bot's allowed chat id.

    See https://core.telegram.org/bots/api#sendmessagedraft.
    """
    data = request.get_json(silent=True) or {}
    raw_draft_id = data.get("draft_id")
    text = data.get("text", "") or ""
    parse_mode = data.get("parse_mode") or None
    try:
        draft_id = int(raw_draft_id) if raw_draft_id is not None else 0
    except (TypeError, ValueError):
        return jsonify({"error": "draft_id must be a non-zero integer"}), 400
    if draft_id == 0:
        return jsonify({"error": "draft_id must be a non-zero integer"}), 400
    target = _outbound_chat_id()
    if not _bot_application or _bot_application == "starting" or not _bot_loop or not target:
        return jsonify({"error": "Telegram not configured"}), 400
    try:
        # Telegram requires `chat_id` as int for sendMessageDraft (private chats only).
        try:
            chat_id_int = int(target)
        except (TypeError, ValueError):
            return jsonify({"error": "Configured chat id is not numeric"}), 400
        future = asyncio.run_coroutine_threadsafe(
            _bot_application.bot.send_message_draft(
                chat_id=chat_id_int,
                draft_id=draft_id,
                text=text,
                parse_mode=parse_mode,
            ),
            _bot_loop,
        )
        future.result(timeout=10)
        return jsonify({"status": "ok"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/send-telegram-chat-action")
def send_telegram_chat_action():
    """Show a chat action (typing, upload_photo, …) in the Telegram chat.

    Body: { action: str } — defaults to "typing".

    Telegram chat actions auto-expire after ~5s on the client, so callers
    that want a persistent indicator must re-send every 4s for the duration
    of the long-running operation. See
    https://core.telegram.org/bots/api#sendchataction
    """
    data = request.get_json(silent=True) or {}
    action = data.get("action") or "typing"
    target = _outbound_chat_id()
    if not _bot_application or _bot_application == "starting" or not _bot_loop or not target:
        return jsonify({"error": "Telegram not configured"}), 400
    try:
        future = asyncio.run_coroutine_threadsafe(
            _bot_application.bot.send_chat_action(chat_id=target, action=action),
            _bot_loop,
        )
        future.result(timeout=10)
        return jsonify({"status": "ok"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/send-telegram-keyboard")
def send_telegram_keyboard():
    """Send a text reply with an InlineKeyboardMarkup attached.

    Body: { text: str, parse_mode?: str,
            buttons: [[{text: str, callback_data: str}, ...], ...] }

    Each row in `buttons` becomes one keyboard row; each entry within a row
    becomes one InlineKeyboardButton. callback_data is opaque (max 64 bytes
    per Telegram); the callback handler is responsible for routing it.
    """
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup

    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    parse_mode = data.get("parse_mode") or None
    rows = data.get("buttons", []) or []
    target = _outbound_chat_id()
    if not _bot_application or _bot_application == "starting" or not _bot_loop or not target:
        return jsonify({"error": "Telegram not configured"}), 400
    try:
        keyboard = [
            [
                InlineKeyboardButton(
                    text=str(btn.get("text", "")),
                    callback_data=str(btn.get("callback_data", "")),
                )
                for btn in row
            ]
            for row in rows
        ]
        markup = InlineKeyboardMarkup(keyboard) if keyboard else None
        future = asyncio.run_coroutine_threadsafe(
            _bot_application.bot.send_message(
                chat_id=target,
                text=text,
                parse_mode=parse_mode,
                reply_markup=markup,
            ),
            _bot_loop,
        )
        future.result(timeout=10)
        return jsonify({"status": "ok"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── Slack control ─────────────────────────────────────────────────────────────

@app.post("/set-slack-tokens")
def set_slack_tokens():
    """Inject Slack bot + app-level tokens at runtime to start the Socket Mode bot.

    If a bot is already running with the same tokens, just apply any updated
    `userId`. If tokens changed, gracefully stop the existing bot and start a
    new one — mirrors the Telegram `/set-telegram-token` lifecycle so credential
    changes never require a Flask restart.
    """
    global _slack_app_instance, _allowed_slack_user_id, _slack_thread
    data = request.get_json(silent=True) or {}
    bot_token = (data.get("botToken") or "").strip()
    app_token = (data.get("appToken") or "").strip()
    raw_user = data.get("userId")
    cleaned_user = str(raw_user).strip() if raw_user is not None and str(raw_user).strip() else ""
    if not bot_token or not app_token:
        return jsonify({"error": "botToken and appToken are required"}), 400

    thread_to_join: threading.Thread | None = None
    with _slack_start_lock:
        if _slack_app_instance == "starting":
            return jsonify({"status": "starting"}), 409
        if _slack_app_instance is not None:
            same_tokens = _slack_bot_token == bot_token and _slack_app_token == app_token
            if same_tokens:
                if cleaned_user:
                    _allowed_slack_user_id = cleaned_user
                    logger.info(
                        "Slack bot already running — applied user_id=%s", cleaned_user
                    )
                return jsonify({"status": "already_running", "userUpdated": bool(cleaned_user)})
            logger.info("Slack tokens changed — restarting bot")
            loop = _slack_loop
            ev = _slack_shutdown_event
            if loop is not None and ev is not None:
                try:
                    loop.call_soon_threadsafe(ev.set)
                except Exception as exc:
                    logger.warning("Could not signal slack bot shutdown: %s", exc)
            thread_to_join = _slack_thread
        _slack_app_instance = "starting"

    if thread_to_join is not None and thread_to_join.is_alive():
        thread_to_join.join(timeout=10)
        if thread_to_join.is_alive():
            logger.warning("Previous Slack bot thread did not exit within 10s")

    t = threading.Thread(
        target=_start_slack_bot, args=(bot_token, app_token, cleaned_user), daemon=True
    )
    _slack_thread = t
    t.start()
    logger.info("Started Slack bot via /set-slack-tokens")
    return jsonify({"status": "started"})


@app.get("/get-slack-user-id")
def get_slack_user_id():
    """Return the first DM partner the Slack bot has seen (memory or persisted)."""
    user_id = _last_seen_slack_user_id or _load_persisted_slack_user_id()
    if user_id:
        return jsonify({"userId": user_id})
    return (
        jsonify(
            {
                "error": "No DM received yet. DM your Slack bot, then click Detect.",
            }
        ),
        404,
    )


@app.get("/poll-slack")
def poll_slack():
    """Return and clear all pending Slack messages."""
    with _slack_pending_lock:
        msgs = list(_slack_pending_messages)
        _slack_pending_messages.clear()
    return jsonify(msgs)


@app.post("/flush-slack-pending")
def flush_slack_pending():
    """Discard all pending Slack messages without processing them."""
    with _slack_pending_lock:
        count = len(_slack_pending_messages)
        _slack_pending_messages.clear()
    logger.info("flush-slack-pending: discarded %d messages", count)
    return jsonify({"flushed": count})


def _slack_outbound_target(channel_hint: str | None = None) -> str | None:
    """Resolve where to send outbound Slack messages.

    Order of preference: explicit `channel_hint` (if provided), the IM channel
    captured on first inbound DM, then the allowed user id (Slack accepts both
    forms for `chat.postMessage`).
    """
    for cand in (channel_hint, _slack_im_channel, _allowed_slack_user_id, _last_seen_slack_user_id):
        if cand and str(cand).strip():
            return str(cand).strip()
    return None


def _slack_running() -> bool:
    return (
        _slack_app_instance is not None
        and _slack_app_instance != "starting"
        and _slack_loop is not None
    )


def _slack_run_coro(coro):
    """Schedule an async coroutine on the Slack bot's event loop and wait."""
    if _slack_loop is None:
        raise RuntimeError("Slack bot event loop is not running")
    future = asyncio.run_coroutine_threadsafe(coro, _slack_loop)
    return future.result(timeout=30)


@app.post("/send-slack-reply")
def send_slack_reply():
    """Send a chat.postMessage. Body: { text, blocks?, channel?, thread_ts? }.

    Returns the posted `{ts, channel}` so the streaming layer can later edit
    the same message in place via /send-slack-update.
    """
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    blocks = data.get("blocks")
    thread_ts = data.get("thread_ts")
    target = _slack_outbound_target(data.get("channel"))
    if not _slack_running() or not target:
        return jsonify({"error": "Slack not configured"}), 400
    try:
        kwargs: dict = {"channel": target, "text": text}
        if blocks:
            kwargs["blocks"] = blocks
        if thread_ts:
            kwargs["thread_ts"] = thread_ts
        resp = _slack_run_coro(_slack_app_instance.client.chat_postMessage(**kwargs))
        return jsonify(
            {"status": "ok", "ts": resp.get("ts"), "channel": resp.get("channel") or target}
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/send-slack-update")
def send_slack_update():
    """Edit an existing Slack message via chat.update.

    Body: { channel, ts, text, blocks? }. Used by the renderer's draft-stream
    helper to animate streaming output without spamming new bubbles.
    """
    data = request.get_json(silent=True) or {}
    channel = (data.get("channel") or "").strip()
    ts = (data.get("ts") or "").strip()
    text = data.get("text", "")
    blocks = data.get("blocks")
    if not channel or not ts:
        return jsonify({"error": "channel and ts are required"}), 400
    if not _slack_running():
        return jsonify({"error": "Slack not configured"}), 400
    try:
        kwargs: dict = {"channel": channel, "ts": ts, "text": text}
        if blocks:
            kwargs["blocks"] = blocks
        _slack_run_coro(_slack_app_instance.client.chat_update(**kwargs))
        return jsonify({"status": "ok"})
    except Exception as exc:
        # Drafts/updates are best-effort; surface the failure to the caller so
        # the throttle can skip retrying with the same content.
        return jsonify({"error": str(exc)}), 500


@app.post("/send-slack-photo")
def send_slack_photo():
    """Upload an image via files.upload_v2. Body: { photo: base64, caption?, channel?, thread_ts? }."""
    import base64
    import time
    data = request.get_json(silent=True) or {}
    photo_b64 = data.get("photo", "")
    caption = data.get("caption", "") or ""
    thread_ts = data.get("thread_ts")
    target = _slack_outbound_target(data.get("channel"))
    if not _slack_running() or not target:
        return jsonify({"error": "Slack not configured"}), 400
    try:
        photo_bytes = base64.b64decode(photo_b64)
        kwargs: dict = {
            "channel": target,
            "file": photo_bytes,
            "filename": f"aipg-{int(time.time() * 1000)}.png",
        }
        if caption:
            kwargs["initial_comment"] = caption
        if thread_ts:
            kwargs["thread_ts"] = thread_ts
        _slack_run_coro(_slack_app_instance.client.files_upload_v2(**kwargs))
        return jsonify({"status": "ok"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/send-slack-typing-reaction")
def send_slack_typing_reaction():
    """Add or remove a reaction emoji on an inbound message.

    Slack has no DM "typing…" indicator equivalent to Telegram's chat actions,
    so we follow OpenClaw's pattern and use `reactions.add`/`reactions.remove`
    to signal that the bot is processing (`:eyes:` by default).

    Body: { channel, ts, name?, action: "add"|"remove" }
    """
    data = request.get_json(silent=True) or {}
    channel = (data.get("channel") or "").strip()
    ts = (data.get("ts") or "").strip()
    name = (data.get("name") or "eyes").strip()
    action = (data.get("action") or "add").strip()
    if not channel or not ts:
        return jsonify({"error": "channel and ts are required"}), 400
    if not _slack_running():
        return jsonify({"error": "Slack not configured"}), 400
    try:
        if action == "remove":
            _slack_run_coro(
                _slack_app_instance.client.reactions_remove(channel=channel, timestamp=ts, name=name)
            )
        else:
            _slack_run_coro(
                _slack_app_instance.client.reactions_add(channel=channel, timestamp=ts, name=name)
            )
        return jsonify({"status": "ok"})
    except Exception as exc:
        # Reactions can fail with `already_reacted` / `no_reaction` benignly.
        return jsonify({"error": str(exc)}), 500


@app.post("/send-slack-keyboard")
def send_slack_keyboard():
    """Send a text reply with Slack Block Kit `actions` blocks attached.

    Body: { text, blocks }. `blocks` is the raw Block Kit array — the renderer
    builds it (button labels, action_id values) so this endpoint stays a thin
    pass-through. Returns posted `{ts, channel}`.
    """
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    blocks = data.get("blocks") or []
    target = _slack_outbound_target(data.get("channel"))
    if not _slack_running() or not target:
        return jsonify({"error": "Slack not configured"}), 400
    try:
        resp = _slack_run_coro(
            _slack_app_instance.client.chat_postMessage(channel=target, text=text, blocks=blocks)
        )
        return jsonify(
            {"status": "ok", "ts": resp.get("ts"), "channel": resp.get("channel") or target}
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── Chat completions proxy ────────────────────────────────────────────────────

@app.post("/v1/chat/completions")
def chat_completions():
    upstream = request.headers.get("X-Upstream-Url")
    with _upstream_lock:
        upstream = upstream or _upstream_url
    if not upstream:
        return jsonify({"error": "No upstream URL provided"}), 400
    return proxy_chat_completions(upstream, request)


# ── Telegram bot ──────────────────────────────────────────────────────────────

def _start_telegram_bot(token: str, initial_chat_id: str) -> None:
    """Runs the Telegram bot in its own asyncio event loop (daemon thread)."""
    global _bot_application, _bot_loop, _last_seen_chat_id, _bot_token, _bot_chat_id, _allowed_chat_id
    from telegram import Update
    from telegram.ext import Application, MessageHandler, filters, ContextTypes

    _bot_token = token
    _allowed_chat_id = (initial_chat_id or "").strip()
    _bot_chat_id = _allowed_chat_id

    async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        global _last_seen_chat_id, _allowed_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if not allow:
            logger.info("Detection mode: received message from chat_id=%s (not yet configured)", chat_id)
            return
        if chat_id != allow:
            logger.warning("Ignoring message from unauthorized chat_id: %s", chat_id)
            return
        user_text = update.message.text or ""
        logger.info(
            "Telegram message received: chat_id=%s message_id=%s length=%d",
            chat_id,
            update.message.message_id,
            len(user_text),
        )
        with _pending_lock:
            _pending_messages.append({"text": user_text, "chat_id": chat_id})

    async def handle_help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /help — queue a special help marker for the frontend to reply with."""
        global _last_seen_chat_id, _allowed_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if not allow:
            return
        if chat_id != allow:
            logger.warning("Ignoring /help from unauthorized chat_id: %s", chat_id)
            return
        logger.info("Telegram /help command received: chat_id=%s", chat_id)
        with _pending_lock:
            _pending_messages.append({"text": "/help", "chat_id": chat_id})

    async def handle_chat_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /chat <message> — force text chat mode, skip agentic image generation."""
        global _last_seen_chat_id, _allowed_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if not allow:
            return
        if chat_id != allow:
            logger.warning("Ignoring /chat from unauthorized chat_id: %s", chat_id)
            return
        args = context.args or []
        prompt_part = " ".join(args)
        full_text = f"/chat {prompt_part}".strip()
        logger.info("Telegram /chat command received: chat_id=%s message=%r", chat_id, prompt_part)
        with _pending_lock:
            _pending_messages.append({"text": full_text, "chat_id": chat_id})

    async def handle_imggen_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /imgGen <prompt> as a Telegram command."""
        global _last_seen_chat_id, _allowed_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if not allow:
            logger.info("Detection mode: received /imgGen from chat_id=%s (not yet configured)", chat_id)
            return
        if chat_id != allow:
            logger.warning("Ignoring /imgGen from unauthorized chat_id: %s", chat_id)
            return
        # Reconstruct text as "/imgGen <args>" so the frontend routing works uniformly
        args = context.args or []
        prompt_part = " ".join(args)
        full_text = f"/imgGen {prompt_part}".strip()
        logger.info(
            "Telegram /imgGen command received: chat_id=%s prompt=%r",
            chat_id,
            prompt_part,
        )
        with _pending_lock:
            _pending_messages.append({"text": full_text, "chat_id": chat_id})

    async def handle_new_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /new — start a fresh Home Agent chat thread (handled by Electron)."""
        global _last_seen_chat_id, _allowed_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if not allow:
            return
        if chat_id != allow:
            logger.warning("Ignoring /new from unauthorized chat_id: %s", chat_id)
            return
        logger.info("Telegram /new command received: chat_id=%s", chat_id)
        with _pending_lock:
            _pending_messages.append({"text": "/new", "chat_id": chat_id})

    async def handle_history_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /history — list saved Home Agent chat threads (handled by Electron)."""
        global _last_seen_chat_id, _allowed_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if not allow:
            return
        if chat_id != allow:
            logger.warning("Ignoring /history from unauthorized chat_id: %s", chat_id)
            return
        logger.info("Telegram /history command received: chat_id=%s", chat_id)
        with _pending_lock:
            _pending_messages.append({"text": "/history", "chat_id": chat_id})

    async def handle_load_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /load <id> — resume one of the saved Home Agent chat threads."""
        global _last_seen_chat_id, _allowed_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if not allow:
            return
        if chat_id != allow:
            logger.warning("Ignoring /load from unauthorized chat_id: %s", chat_id)
            return
        # Reconstruct text as "/load <args>" so the frontend regex matches uniformly.
        args = context.args or []
        arg_part = " ".join(args)
        full_text = f"/load {arg_part}".strip()
        logger.info(
            "Telegram /load command received: chat_id=%s arg=%r", chat_id, arg_part
        )
        with _pending_lock:
            _pending_messages.append({"text": full_text, "chat_id": chat_id})

    async def handle_cancel_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /cancel — clear any pending image-generation prompt (handled by Electron)."""
        global _last_seen_chat_id, _allowed_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if not allow:
            return
        if chat_id != allow:
            logger.warning("Ignoring /cancel from unauthorized chat_id: %s", chat_id)
            return
        logger.info("Telegram /cancel command received: chat_id=%s", chat_id)
        with _pending_lock:
            _pending_messages.append({"text": "/cancel", "chat_id": chat_id})

    async def handle_imggen_callback(
        update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle inline-keyboard taps from the /imgGen preset picker.

        Buttons carry `callback_data` of the form `imgGen:preset:<name>` or
        `imgGen:cancel`. We ack the query and push a `{callback: ...}` queue
        item so the frontend can branch without text sentinels.
        """
        global _last_seen_chat_id, _allowed_chat_id
        cq = update.callback_query
        if cq is None or cq.message is None:
            return
        chat_id = str(cq.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if allow and chat_id != allow:
            logger.warning("Ignoring imgGen callback from unauthorized chat_id: %s", chat_id)
            try:
                await cq.answer()
            except Exception as exc:
                logger.debug("imgGen unauthorized ack failed: %s", exc)
            return
        data = cq.data or ""
        try:
            await cq.answer()
        except Exception as exc:
            logger.warning("Failed to ack imgGen callback_query: %s", exc)
        if not data.startswith("imgGen:"):
            return
        logger.info("Telegram imgGen callback: chat_id=%s data=%r", chat_id, data)
        with _pending_lock:
            _pending_messages.append({"chat_id": chat_id, "callback": data})

    async def handle_load_callback(
        update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle inline-keyboard taps from the bare `/load` menu.

        The frontend sends button rows with callback_data of the form
        `loadConv:<conversation_key>`. We answer the callback (so the client
        clears its loading spinner) and synthesise a normal `/load <key>`
        message into the queue so the existing renderer routing handles it.
        """
        global _last_seen_chat_id, _allowed_chat_id
        cq = update.callback_query
        if cq is None or cq.message is None:
            return
        chat_id = str(cq.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if allow and chat_id != allow:
            logger.warning("Ignoring callback from unauthorized chat_id: %s", chat_id)
            try:
                await cq.answer()
            except Exception as exc:
                logger.debug("loadConv unauthorized ack failed: %s", exc)
            return
        data = cq.data or ""
        try:
            await cq.answer()
        except Exception as exc:
            logger.warning("Failed to ack callback_query: %s", exc)
        if not data.startswith("loadConv:"):
            return
        key = data[len("loadConv:"):]
        full_text = f"/load {key}".strip()
        logger.info(
            "Telegram load-menu callback: chat_id=%s key=%r", chat_id, key
        )
        with _pending_lock:
            _pending_messages.append({"text": full_text, "chat_id": chat_id})

    async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle a photo message — download the largest size and queue as base64."""
        import base64

        global _last_seen_chat_id, _allowed_chat_id
        if update.message is None or not update.message.photo:
            return
        chat_id = str(update.message.chat_id)
        allow = _allowed_chat_id
        _record_authorized_chat_id(chat_id)
        if not allow:
            logger.info("Detection mode: received photo from chat_id=%s (not yet configured)", chat_id)
            return
        if chat_id != allow:
            logger.warning("Ignoring photo from unauthorized chat_id: %s", chat_id)
            return

        # Telegram photo array is sorted smallest → largest; pick the largest.
        photo = update.message.photo[-1]
        try:
            tg_file = await context.bot.get_file(photo.file_id)
            raw = await tg_file.download_as_bytearray()
        except Exception as exc:
            logger.error("Failed to download Telegram photo: %s", exc)
            return

        data_b64 = base64.b64encode(bytes(raw)).decode("ascii")
        # Telegram always serves photos as JPEG.
        caption = update.message.caption or ""
        # Provide a non-empty placeholder text so downstream regex routing works.
        text_payload = caption if caption else "[image]"
        logger.info(
            "Telegram photo received: chat_id=%s message_id=%s caption_len=%d size_bytes=%d",
            chat_id,
            update.message.message_id,
            len(caption),
            len(raw),
        )
        with _pending_lock:
            _pending_messages.append(
                {
                    "text": text_payload,
                    "chat_id": chat_id,
                    "images": [{"mime": "image/jpeg", "data_base64": data_b64}],
                }
            )

    async def run() -> None:
        global _bot_application, _bot_loop, _last_seen_chat_id, _bot_shutdown_event
        _bot_loop = asyncio.get_event_loop()
        _bot_shutdown_event = asyncio.Event()
        application = Application.builder().token(token).build()
        _bot_application = application
        application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
        application.add_handler(MessageHandler(filters.PHOTO, handle_photo))
        from telegram import BotCommand
        from telegram.ext import CallbackQueryHandler, CommandHandler
        # `python-telegram-bot`'s CommandHandler matches case-sensitively and
        # Telegram's setMyCommands menu entries must be lowercase, so we register
        # both spellings for /imgGen to keep the historical text trigger working
        # *and* surface a lowercase autocomplete entry users can tap on.
        application.add_handler(CommandHandler(["imggen", "imgGen"], handle_imggen_command))
        application.add_handler(CommandHandler("help", handle_help_command))
        application.add_handler(CommandHandler("start", handle_help_command))
        application.add_handler(CommandHandler("chat", handle_chat_command))
        application.add_handler(CommandHandler("cancel", handle_cancel_command))
        application.add_handler(CommandHandler("new", handle_new_command))
        application.add_handler(CommandHandler("history", handle_history_command))
        application.add_handler(CommandHandler("load", handle_load_command))
        application.add_handler(
            CallbackQueryHandler(handle_load_callback, pattern=r"^loadConv:")
        )
        application.add_handler(
            CallbackQueryHandler(handle_imggen_callback, pattern=r"^imgGen:")
        )
        await application.initialize()
        await application.start()
        await application.bot.delete_webhook(drop_pending_updates=False)

        # Populate the Telegram client's "/" autocomplete menu so users can
        # discover and tap commands instead of typing them blind.
        try:
            await application.bot.set_my_commands(
                [
                    BotCommand("help", "Show available commands"),
                    BotCommand("chat", "Force a text chat reply (no image generation)"),
                    BotCommand("imggen", "Pick a preset and generate an image"),
                    BotCommand("cancel", "Cancel a pending image-generation prompt"),
                    BotCommand("new", "Start a new Home Agent chat thread"),
                    BotCommand("history", "List your saved Home Agent chats"),
                    BotCommand("load", "Resume a chat (no id = pick from menu)"),
                ]
            )
            logger.info("Registered Telegram bot command menu")
        except Exception as exc:
            logger.warning("Failed to register Telegram command menu: %s", exc)

        # Pre-populate chat ID from any pending updates before polling starts,
        # then acknowledge them so start_polling does not re-deliver them.
        try:
            updates = await application.bot.get_updates(limit=100, timeout=0)
            if updates:
                cid = next(
                    (str(u.message.chat_id) for u in updates if u.message),
                    None,
                )
                if cid:
                    _last_seen_chat_id = cid
                    _persist_chat_id(cid)
                    logger.info("Pre-populated chat_id from pending updates: %s", cid)
                # Acknowledge all fetched updates so polling won't re-process them
                highest_update_id = max(u.update_id for u in updates)
                await application.bot.get_updates(offset=highest_update_id + 1, limit=1, timeout=0)
                logger.info("Acknowledged updates up to update_id=%d", highest_update_id)
            if not _last_seen_chat_id:
                _last_seen_chat_id = _load_persisted_chat_id()
        except Exception as exc:
            logger.warning("Could not pre-populate chat_id: %s", exc)

        await application.updater.start_polling(drop_pending_updates=False)
        try:
            await _bot_shutdown_event.wait()
        finally:
            # Graceful shutdown so a new token can take effect without
            # restarting the Flask process.
            try:
                await application.updater.stop()
            except Exception as exc:
                logger.warning("application.updater.stop() failed: %s", exc)
            try:
                await application.stop()
            except Exception as exc:
                logger.warning("application.stop() failed: %s", exc)
            try:
                await application.shutdown()
            except Exception as exc:
                logger.warning("application.shutdown() failed: %s", exc)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _bot_loop = loop
    try:
        loop.run_until_complete(run())
    except Exception as exc:
        logger.error("Telegram bot crashed: %s", exc)
    finally:
        _bot_application = None  # allow retry
        _bot_loop = None
        _bot_shutdown_event = None
        try:
            loop.close()
        except Exception:
            pass


# ── Slack bot ─────────────────────────────────────────────────────────────────

def _start_slack_bot(bot_token: str, app_token: str, initial_user_id: str) -> None:
    """Runs the Slack Bolt Socket Mode bot in its own asyncio event loop.

    Mirrors `_start_telegram_bot`:
      - daemon thread + dedicated event loop
      - graceful shutdown via `_slack_shutdown_event` so credential changes
        from /set-slack-tokens never need a Flask restart
      - DMs only (`channel_type == "im"`); detection mode populates
        `_last_seen_slack_user_id` until the renderer issues a verified
        userId via /set-slack-tokens.
    """
    global _slack_app_instance, _slack_loop, _slack_bot_token, _slack_app_token
    global _allowed_slack_user_id, _last_seen_slack_user_id, _slack_shutdown_event
    global _slack_im_channel

    # slack-bolt imports are deferred so the rest of the Flask app boots even
    # when the package is missing (e.g. legacy installs that have not yet run
    # `uv sync`). Slack endpoints just refuse with `Slack not configured`.
    try:
        from slack_bolt.async_app import AsyncApp
        from slack_bolt.adapter.socket_mode.aiohttp import AsyncSocketModeHandler
    except ImportError as exc:
        logger.error("slack-bolt is not installed: %s", exc)
        _slack_app_instance = None
        return

    _slack_bot_token = bot_token
    _slack_app_token = app_token
    _allowed_slack_user_id = (initial_user_id or "").strip()

    async def _enqueue_command(command_text: str, user_id: str, channel: str) -> None:
        if not _allowed_slack_user_id:
            logger.info(
                "Detection mode: slack command from user_id=%s (not yet configured)", user_id
            )
            return
        if user_id != _allowed_slack_user_id:
            logger.warning("Ignoring slack command from unauthorized user_id: %s", user_id)
            return
        with _slack_pending_lock:
            _slack_pending_messages.append(
                {"text": command_text, "chat_id": user_id, "channel": channel}
            )

    async def _maybe_remember_user(user_id: str, channel: str | None) -> None:
        """Track the last-seen DM partner so detection survives /set-slack-tokens."""
        global _last_seen_slack_user_id, _slack_im_channel
        if user_id and user_id != _last_seen_slack_user_id:
            _last_seen_slack_user_id = user_id
            _persist_slack_user_id(user_id)
        # Cache the IM channel id (D...) for outbound sends. Falling back to the
        # user id works for chat.postMessage but not for reactions/files in some
        # workspaces.
        if channel and channel.startswith("D"):
            _slack_im_channel = channel

    async def _download_slack_files(
        files: list[dict], client_token: str
    ) -> list[dict]:
        """Best-effort: download bot-accessible Slack files into base64 image payloads.

        Mirrors the Telegram photo flow so the renderer receives the same
        `images: [{mime, data_base64}]` shape regardless of channel.
        """
        import base64
        out: list[dict] = []
        # Reuse aiohttp from slack-bolt's bundled dependency tree.
        import aiohttp
        async with aiohttp.ClientSession(
            headers={"Authorization": f"Bearer {client_token}"}
        ) as session:
            for f in files[:8]:  # cap parity with OpenClaw's 8-files-per-msg note
                mime = f.get("mimetype") or ""
                if not mime.startswith("image/"):
                    continue
                url = f.get("url_private_download") or f.get("url_private")
                if not url:
                    continue
                try:
                    async with session.get(url) as resp:
                        if resp.status != 200:
                            logger.warning(
                                "slack file download failed: status=%d", resp.status
                            )
                            continue
                        raw = await resp.read()
                except Exception as exc:
                    logger.error("slack file download error: %s", exc)
                    continue
                out.append(
                    {"mime": mime, "data_base64": base64.b64encode(raw).decode("ascii")}
                )
        return out

    async def run() -> None:
        global _slack_app_instance, _slack_loop, _slack_shutdown_event
        _slack_loop = asyncio.get_event_loop()
        _slack_shutdown_event = asyncio.Event()

        bolt_app = AsyncApp(token=bot_token)
        _slack_app_instance = bolt_app

        @bolt_app.event("message")
        async def on_message(event, say, body):  # type: ignore[no-untyped-def]
            # DMs only — gate hard on channel_type so future group/channel
            # support is a deliberate opt-in instead of an accident.
            if event.get("channel_type") != "im":
                return
            # Ignore bot's own messages and message-edited / message-deleted
            # subtypes — those would loop or surface stale text.
            if event.get("subtype") in (
                "message_changed",
                "message_deleted",
                "bot_message",
            ):
                return
            if event.get("bot_id"):
                return
            user_id = event.get("user") or ""
            channel = event.get("channel") or ""
            await _maybe_remember_user(user_id, channel)

            allow = _allowed_slack_user_id
            if not allow:
                logger.info(
                    "Detection mode: slack DM from user_id=%s (not yet configured)", user_id
                )
                return
            if user_id != allow:
                logger.warning("Ignoring slack DM from unauthorized user_id: %s", user_id)
                return

            text = event.get("text") or ""
            ts = event.get("ts") or ""
            files = event.get("files") or []
            images = await _download_slack_files(files, bot_token) if files else []
            text_payload = text if text else ("[image]" if images else "")
            logger.info(
                "Slack DM received: user_id=%s channel=%s ts=%s len=%d images=%d",
                user_id,
                channel,
                ts,
                len(text),
                len(images),
            )
            with _slack_pending_lock:
                _slack_pending_messages.append(
                    {
                        "text": text_payload,
                        "chat_id": user_id,
                        "channel": channel,
                        "ts": ts,
                        **({"images": images} if images else {}),
                    }
                )

        async def _handle_slash(ack, command, full_text: str) -> None:
            await ack()
            await _maybe_remember_user(command.get("user_id") or "", command.get("channel_id"))
            await _enqueue_command(
                full_text,
                command.get("user_id") or "",
                command.get("channel_id") or "",
            )

        @bolt_app.command("/help")
        async def cmd_help(ack, command):  # type: ignore[no-untyped-def]
            await _handle_slash(ack, command, "/help")

        @bolt_app.command("/chat")
        async def cmd_chat(ack, command):  # type: ignore[no-untyped-def]
            text = (command.get("text") or "").strip()
            await _handle_slash(ack, command, f"/chat {text}".strip())

        @bolt_app.command("/imggen")
        async def cmd_imggen(ack, command):  # type: ignore[no-untyped-def]
            text = (command.get("text") or "").strip()
            await _handle_slash(ack, command, f"/imgGen {text}".strip())

        @bolt_app.command("/new")
        async def cmd_new(ack, command):  # type: ignore[no-untyped-def]
            await _handle_slash(ack, command, "/new")

        @bolt_app.command("/history")
        async def cmd_history(ack, command):  # type: ignore[no-untyped-def]
            await _handle_slash(ack, command, "/history")

        @bolt_app.command("/load")
        async def cmd_load(ack, command):  # type: ignore[no-untyped-def]
            text = (command.get("text") or "").strip()
            await _handle_slash(ack, command, f"/load {text}".strip())

        @bolt_app.command("/cancel")
        async def cmd_cancel(ack, command):  # type: ignore[no-untyped-def]
            await _handle_slash(ack, command, "/cancel")

        @bolt_app.action(re.compile(r"^imgGen:"))
        async def on_imggen_action(ack, body, action):  # type: ignore[no-untyped-def]
            await ack()
            user = (body.get("user") or {}).get("id") or ""
            channel = (body.get("channel") or {}).get("id") or ""
            await _maybe_remember_user(user, channel)
            if _allowed_slack_user_id and user != _allowed_slack_user_id:
                logger.warning("Ignoring imgGen action from unauthorized user_id: %s", user)
                return
            value = action.get("value") or action.get("action_id") or ""
            logger.info("Slack imgGen action: user=%s value=%s", user, value)
            with _slack_pending_lock:
                _slack_pending_messages.append(
                    {"chat_id": user, "channel": channel, "callback": value}
                )

        @bolt_app.action(re.compile(r"^loadConv:"))
        async def on_loadconv_action(ack, body, action):  # type: ignore[no-untyped-def]
            await ack()
            user = (body.get("user") or {}).get("id") or ""
            channel = (body.get("channel") or {}).get("id") or ""
            await _maybe_remember_user(user, channel)
            if _allowed_slack_user_id and user != _allowed_slack_user_id:
                logger.warning("Ignoring loadConv action from unauthorized user_id: %s", user)
                return
            value = action.get("value") or action.get("action_id") or ""
            # Mirror the Telegram callback shape: synthesize a `/load <key>` so
            # the renderer's drain queue handles it uniformly with slash commands.
            key = value[len("loadConv:"):] if value.startswith("loadConv:") else value
            logger.info("Slack loadConv action: user=%s key=%s", user, key)
            with _slack_pending_lock:
                _slack_pending_messages.append(
                    {"text": f"/load {key}".strip(), "chat_id": user, "channel": channel}
                )

        handler = AsyncSocketModeHandler(bolt_app, app_token)
        try:
            await handler.connect_async()
            logger.info("Slack Socket Mode bot connected")
        except Exception as exc:
            logger.error("Slack Socket Mode connect failed: %s", exc)
            raise

        try:
            await _slack_shutdown_event.wait()
        finally:
            try:
                await handler.close_async()
            except Exception as exc:
                logger.warning("Slack handler.close_async() failed: %s", exc)
            try:
                await bolt_app.async_stop()
            except Exception as exc:
                logger.warning("Slack bolt_app.async_stop() failed: %s", exc)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _slack_loop = loop
    try:
        loop.run_until_complete(run())
    except Exception as exc:
        logger.error("Slack bot crashed: %s", exc)
    finally:
        _slack_app_instance = None
        _slack_loop = None
        _slack_shutdown_event = None
        try:
            loop.close()
        except Exception:
            pass


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=58000)
    args = parser.parse_args()

    _install_log_redaction()
    logging.basicConfig(level=logging.INFO)
    print(f"Home Agent backend starting on port {args.port} (chat_id file: {_CHAT_ID_FILE})", flush=True)

    tg_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    tg_chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    print(f"Telegram config: token={'SET' if tg_token else 'NOT SET'} chat_id={'SET' if tg_chat_id else 'NOT SET'}", flush=True)
    # Electron must NOT pass TELEGRAM_* here — only /set-telegram-token (see homeAgentBackendService).
    # CLI / manual runs may still use env for local debugging.
    if tg_token:
        print(f"Starting Telegram bot (allowed chat: {tg_chat_id or 'any — detecting'})", flush=True)
        threading.Thread(target=_start_telegram_bot, args=(tg_token, tg_chat_id), daemon=True).start()
    else:
        print("No TELEGRAM_BOT_TOKEN — Telegram bot disabled.", flush=True)

    # Slack bot — same env-fallback pattern. Electron uses /set-slack-tokens.
    sl_bot = os.environ.get("SLACK_BOT_TOKEN")
    sl_app = os.environ.get("SLACK_APP_TOKEN")
    sl_user = os.environ.get("SLACK_USER_ID", "")
    print(
        f"Slack config: botToken={'SET' if sl_bot else 'NOT SET'} "
        f"appToken={'SET' if sl_app else 'NOT SET'} "
        f"user_id={'SET' if sl_user else 'NOT SET'}",
        flush=True,
    )
    if sl_bot and sl_app:
        print(
            f"Starting Slack bot (allowed user: {sl_user or 'any — detecting'})", flush=True
        )
        threading.Thread(
            target=_start_slack_bot, args=(sl_bot, sl_app, sl_user), daemon=True
        ).start()
    else:
        print("No SLACK_BOT_TOKEN/SLACK_APP_TOKEN — Slack bot disabled.", flush=True)

    # Bind to loopback only — Electron talks to this backend via 127.0.0.1
    # (see homeAgentBackendService.ts `baseUrl`). Restricting the listener
    # prevents the Telegram bot/proxy endpoints from being reachable from
    # other hosts on the network.
    app.run(host="127.0.0.1", port=args.port)

