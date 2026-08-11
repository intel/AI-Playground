"""
Home Agent Backend — thin proxy forwarding /v1/chat/completions to llamaCPP /
OpenVINO and exposing channel-agnostic REST routes for chat-platform bots.

Channel-specific behavior lives in `channels/<kind>.py`; this file dispatches
generic `/channel/<kind>/*` routes against the `channels.registry.CHANNELS`
map and handles upstream URL configuration plus loopback auth.
"""

import argparse
import logging
import os
import re
import sys
import threading

from channels import registry
from channels.actions import send_method_name
from channels.types import ALL_CHANNEL_KINDS
from flask import Flask, jsonify, request
from flask_cors import CORS
from llm_proxy import proxy_chat_completions

# Shared loopback-auth lives in a sibling backend_shared/ directory so the same
# logic is used by every local Python backend (see backend_shared/).
sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend_shared")
)
from aipg_loopback_auth import evaluate_loopback_auth, get_loopback_token

app = Flask(__name__)
CORS(app)

# ── Loopback auth ─────────────────────────────────────────────────────────────
# Flask binds to 127.0.0.1 but on a shared host any local peer can still reach
# our port. Require an `X-AIPG-Auth` header matching the per-launch token the
# Electron main process injected via env. Mirrors the `ai-backend` pattern.
_LOOPBACK_AUTH_TOKEN = get_loopback_token()


@app.before_request
def _enforce_loopback_and_auth():
    rejection = evaluate_loopback_auth(
        request.remote_addr,
        request.method,
        request.path,
        request.headers.get("X-AIPG-Auth", ""),
        expected_token=_LOOPBACK_AUTH_TOKEN,
    )
    if rejection is not None:
        status, message = rejection
        return jsonify({"error": message}), status
    return None


# ── Log redaction ─────────────────────────────────────────────────────────────
# Each channel module contributes its own token regex via `redaction_patterns()`.
# Unioning them here means adding a third channel only requires implementing
# the new channel — no edits to this file.

_REDACTION = "<TOKEN_REDACTED>"


def _collect_redaction_patterns() -> list[re.Pattern[str]]:
    out: list[re.Pattern[str]] = []
    for ch in registry.CHANNELS.values():
        out.extend(ch.redaction_patterns())
    return out


def _redact_one(value: str, patterns: list[re.Pattern[str]]) -> str:
    out = value
    for p in patterns:
        out = p.sub(_REDACTION, out)
    return out


def _redact_token(value: object, patterns: list[re.Pattern[str]]) -> object:
    if isinstance(value, str):
        return _redact_one(value, patterns)
    return value


class _PollAccessFilter(logging.Filter):
    """Suppress werkzeug access-log lines for high-frequency poll endpoints.

    Constructed from the channel registry so any new channel's `/channel/<kind>/poll`
    line is suppressed without editing this filter.
    """

    def __init__(self) -> None:
        super().__init__()
        self._noisy_paths = tuple(f"/channel/{k}/poll" for k in ALL_CHANNEL_KINDS)

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True
        return not any(path in message for path in self._noisy_paths)


def _install_log_redaction() -> None:
    if getattr(logging, "_aipg_redaction_installed", False):
        return

    patterns = _collect_redaction_patterns()
    base_factory = logging.getLogRecordFactory()

    def _redacting_factory(*args, **kwargs):  # type: ignore[no-untyped-def]
        record = base_factory(*args, **kwargs)
        if isinstance(record.msg, str):
            record.msg = _redact_one(record.msg, patterns)
        if record.args:
            if isinstance(record.args, tuple):
                record.args = tuple(_redact_token(a, patterns) for a in record.args)
            elif isinstance(record.args, dict):
                record.args = {
                    k: _redact_token(v, patterns) for k, v in record.args.items()
                }
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
    logging.getLogger("werkzeug").addFilter(_PollAccessFilter())
    logging._aipg_redaction_installed = True  # type: ignore[attr-defined]


# ── Upstream LLM URL ──────────────────────────────────────────────────────────

_upstream_url: str | None = None
_upstream_lock = threading.Lock()

logger = logging.getLogger(__name__)


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


# ── Channel registry — generic dispatch ───────────────────────────────────────
# All channel-specific routes funnel through these handlers, which look up
# the concrete channel from `registry.CHANNELS` and delegate.


def _get_channel_or_404(kind: str):
    ch = registry.get(kind)
    if ch is None:
        return None, (jsonify({"error": f"unknown channel: {kind}"}), 404)
    return ch, None


def _result_to_response(result: dict):
    """Convert a SendResult dict (status / error / _http_status) into a Flask
    JSON response with the appropriate status code.
    """
    status_code = result.pop("_http_status", None)
    if status_code is None:
        status_code = 200 if "error" not in result else 500
    return jsonify(result), status_code


@app.post("/channel/<kind>/config")
def channel_set_config(kind: str):
    ch, err = _get_channel_or_404(kind)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    result = ch.set_config(data)
    return _result_to_response(result)


@app.get("/channel/<kind>/identity")
def channel_get_identity(kind: str):
    ch, err = _get_channel_or_404(kind)
    if err:
        return err
    identity = ch.get_identity()
    if identity:
        return jsonify({"identity": identity})
    return jsonify({"error": "No identity detected yet."}), 404


@app.get("/channel/<kind>/poll")
def channel_poll(kind: str):
    ch, err = _get_channel_or_404(kind)
    if err:
        return err
    return jsonify(ch.poll())


@app.post("/channel/<kind>/flush")
def channel_flush(kind: str):
    ch, err = _get_channel_or_404(kind)
    if err:
        return err
    count = ch.flush_pending()
    logger.info("channel %s flush: discarded %d messages", kind, count)
    return jsonify({"flushed": count})


@app.post("/channel/<kind>/send/<action>")
def channel_send(kind: str, action: str):
    ch, err = _get_channel_or_404(kind)
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    method_name = send_method_name(action)
    if method_name is None:
        return jsonify({"error": f"unknown send action: {action}"}), 404
    method = getattr(ch, method_name, None)
    if method is None:
        # A known action the channel doesn't implement (e.g. `history`, which only
        # the local web page needs). Distinguished from an unknown action so a
        # missing method reads as such in the log.
        return jsonify({"error": f"channel {kind} does not support {action}"}), 404
    result = method(payload)
    return _result_to_response(result)


# ── Chat completions proxy ────────────────────────────────────────────────────


@app.post("/v1/chat/completions")
def chat_completions():
    upstream = request.headers.get("X-Upstream-Url")
    with _upstream_lock:
        upstream = upstream or _upstream_url
    if not upstream:
        return jsonify({"error": "No upstream URL provided"}), 400
    return proxy_chat_completions(upstream, request)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=58000)
    args = parser.parse_args()

    _install_log_redaction()
    logging.basicConfig(level=logging.INFO)
    print(f"Home Agent backend starting on port {args.port}", flush=True)

    # CLI / manual runs may seed credentials via env; Electron uses
    # /channel/<kind>/config exclusively so the subprocess never starts a bot
    # from env in production.
    # Each entry is (seed, required fields). The required set is named explicitly
    # rather than inferred from position: fields that carry a literal default
    # (local-web's port) are always truthy and would silently satisfy a positional
    # check, so reordering the seed could auto-start a channel with no credentials.
    _env_seeds: dict[str, tuple[dict[str, str], tuple[str, ...]]] = {
        "telegram": (
            {
                "token": os.environ.get("TELEGRAM_BOT_TOKEN", ""),
                "chatId": os.environ.get("TELEGRAM_CHAT_ID", ""),
            },
            ("token", "chatId"),
        ),
        "slack": (
            {
                "botToken": os.environ.get("SLACK_BOT_TOKEN", ""),
                "appToken": os.environ.get("SLACK_APP_TOKEN", ""),
                "userId": os.environ.get("SLACK_USER_ID", ""),
            },
            ("botToken", "appToken"),
        ),
        "local-web": (
            {
                "password": os.environ.get("LOCAL_WEB_PASSWORD", ""),
                "port": os.environ.get("LOCAL_WEB_PORT", "8765"),
                "allowLan": os.environ.get("LOCAL_WEB_ALLOW_LAN", "false"),
            },
            ("password",),
        ),
    }
    for kind, (seed, required) in _env_seeds.items():
        # Only auto-start when *every* required field is populated; channels
        # themselves reject incomplete configs with HTTP 400.
        ch = registry.get(kind)
        if ch is None:
            continue
        if all(seed.get(field) for field in required):
            print(f"Auto-starting {kind} from env", flush=True)
            ch.set_config(seed)
        else:
            print(f"No env credentials for {kind} — bot disabled.", flush=True)

    # Loopback bind — Electron talks to this backend via 127.0.0.1.
    app.run(host="127.0.0.1", port=args.port)
