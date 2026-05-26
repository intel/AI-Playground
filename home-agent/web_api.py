"""
Home Agent Backend - thin proxy forwarding /v1/chat/completions to llamaCPP / OpenVINO.

Telegram bot polls for incoming messages and queues them for Electron to pick up.
"""

import argparse
import asyncio
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

# ── Log redaction ─────────────────────────────────────────────────────────────
# Telegram bot tokens look like "<numeric_id>:<base64-ish>" and appear in httpx
# request URLs (e.g. https://api.telegram.org/bot<token>/getUpdates). Strip them
# from every LogRecord at creation, so all child loggers (httpx, telegram.ext,
# werkzeug, …) emit redacted records regardless of where their handlers live.

# Token shape: `<numeric_id>:<base64-ish>`. Intentionally no word boundary on the
# digit side — tokens embed inside URLs like `…/bot<id>:<token>/…`, where the
# preceding char is a letter (no \b match between letter and digit).
_TOKEN_RE = re.compile(r"\d{6,}:[A-Za-z0-9_-]{20,}")
_REDACTION = "<TOKEN_REDACTED>"


def _redact_token(value: object) -> object:
    if isinstance(value, str):
        return _TOKEN_RE.sub(_REDACTION, value)
    return value


class _PollTelegramAccessFilter(logging.Filter):
    """Suppress werkzeug access-log lines for the high-frequency poll endpoints."""

    _NOISY_PATHS = ("/poll-telegram",)

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
            record.msg = _TOKEN_RE.sub(_REDACTION, record.msg)
        if record.args:
            if isinstance(record.args, tuple):
                record.args = tuple(_redact_token(a) for a in record.args)
            elif isinstance(record.args, dict):
                record.args = {k: _redact_token(v) for k, v in record.args.items()}
        return record

    logging.setLogRecordFactory(_redacting_factory)
    # httpx logs the full request URL at INFO; demote to WARNING so token-bearing
    # URLs stay out of the default volume. The factory still scrubs anything that
    # leaks at higher levels.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    # Electron polls /poll-telegram on a tight interval, which otherwise fills
    # the console with werkzeug access lines. Drop those specific records while
    # leaving every other request log intact.
    logging.getLogger("werkzeug").addFilter(_PollTelegramAccessFilter())
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

# Persistent chat ID file — survives restarts
_CHAT_ID_FILE = Path(__file__).parent / ".chat_id"
_last_seen_chat_id: str | None = None
# Allowed chat for queueing + outbound sends (mutable after /set-telegram-token)
_allowed_chat_id: str = ""

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


# Load persisted chat ID at startup
_last_seen_chat_id = _load_persisted_chat_id()


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
    """Inject bot token at runtime to start the polling bot without restart."""
    global _bot_application, _allowed_chat_id, _bot_chat_id
    data = request.get_json(silent=True) or {}
    token = data.get("token", "").strip()
    raw_chat = data.get("chatId")
    cleaned_chat = str(raw_chat).strip() if raw_chat is not None and str(raw_chat).strip() else ""
    if not token:
        return jsonify({"error": "token required"}), 400
    with _bot_start_lock:
        if _bot_application is not None and _bot_application != "starting":
            # Bot already running (e.g. started in "detection" mode with empty chat).
            # Apply chat id so incoming messages are queued — without this, users stay
            # stuck in detection mode forever after Detect + verify.
            if cleaned_chat:
                _allowed_chat_id = cleaned_chat
                _bot_chat_id = cleaned_chat
                logger.info("Telegram bot already running — applied chat_id=%s", cleaned_chat)
            return jsonify({"status": "already_running", "chatUpdated": bool(cleaned_chat)})
        if _bot_application == "starting":
            return jsonify({"status": "starting"}), 409
        _bot_application = "starting"  # sentinel: blocks concurrent requests
    t = threading.Thread(target=_start_telegram_bot, args=(token, cleaned_chat), daemon=True)
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
        if allow and chat_id != allow:
            logger.warning("Ignoring imgGen callback from unauthorized chat_id: %s", chat_id)
            try:
                await cq.answer()
            except Exception:
                pass
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
        if allow and chat_id != allow:
            logger.warning("Ignoring callback from unauthorized chat_id: %s", chat_id)
            try:
                await cq.answer()
            except Exception:
                pass
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
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        allow = _allowed_chat_id
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
        global _bot_application, _bot_loop, _last_seen_chat_id
        _bot_loop = asyncio.get_event_loop()
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
        await asyncio.Event().wait()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _bot_loop = loop
    try:
        loop.run_until_complete(run())
    except Exception as exc:
        logger.error("Telegram bot crashed: %s", exc)
        _bot_application = None  # allow retry


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

    app.run(host="0.0.0.0", port=args.port)  # nosec B104 — intentional: local service must bind all interfaces for Electron IPC

