"""
Home Agent Backend — thin proxy forwarding /v1/chat/completions to llamaCPP /
OpenVINO and exposing channel-agnostic REST routes for chat-platform bots.

Channel-specific behavior lives in `channels/<kind>.py`; this file dispatches
generic `/channel/<kind>/*` routes against the `channels.registry.CHANNELS`
map and handles upstream URL configuration plus loopback auth.
"""

import argparse
import hmac
import logging
import os
import re
import threading

from flask import Flask, jsonify, request
from flask_cors import CORS
from llm_proxy import proxy_chat_completions

from channels import registry
from channels.types import ALL_CHANNEL_KINDS

app = Flask(__name__)
CORS(app)

# ── Loopback auth ─────────────────────────────────────────────────────────────
# Flask binds to 127.0.0.1 but on a shared host any local peer can still reach
# our port. Require an `X-AIPG-Auth` header matching the per-launch token the
# Electron main process injected via env. Mirrors the `ai-backend` pattern.
_LOOPBACK_AUTH_TOKEN = os.environ.get("AIPG_LOOPBACK_TOKEN", "")
_LOOPBACK_REMOTE_ADDRS = frozenset({"127.0.0.1", "::1"})
# `/healthy` must remain reachable so the service registry can probe readiness
# before it has obtained the token.
_AUTH_EXEMPT_PATHS = frozenset({"/healthy"})


@app.before_request
def _enforce_loopback_and_auth():
    if request.remote_addr not in _LOOPBACK_REMOTE_ADDRS:
        return jsonify({"error": "loopback only"}), 403
    if request.method == "OPTIONS":
        return None
    if request.path in _AUTH_EXEMPT_PATHS:
        return None
    if not _LOOPBACK_AUTH_TOKEN:
        return jsonify({"error": "service not provisioned"}), 503
    provided = request.headers.get("X-AIPG-Auth", "")
    if not provided or not hmac.compare_digest(provided, _LOOPBACK_AUTH_TOKEN):
        return jsonify({"error": "unauthorized"}), 401
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
                record.args = {k: _redact_token(v, patterns) for k, v in record.args.items()}
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
    # `action` is one of: reply | update | photo | typing | keyboard
    method_name = f"send_{action}"
    method = getattr(ch, method_name, None)
    if method is None:
        return jsonify({"error": f"unknown send action: {action}"}), 404
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
    _env_seeds = {
        "telegram": {
            "token": os.environ.get("TELEGRAM_BOT_TOKEN", ""),
            "chatId": os.environ.get("TELEGRAM_CHAT_ID", ""),
        },
        "slack": {
            "botToken": os.environ.get("SLACK_BOT_TOKEN", ""),
            "appToken": os.environ.get("SLACK_APP_TOKEN", ""),
            "userId": os.environ.get("SLACK_USER_ID", ""),
        },
    }
    for kind, seed in _env_seeds.items():
        # Only auto-start when *every* required field is populated.
        ch = registry.get(kind)
        if ch is None:
            continue
        # Decide "has all required fields" by checking that the seed has
        # truthy values for the keys the channel cares about. We assume the
        # first one or two keys are required; channels themselves reject
        # incomplete configs with HTTP 400.
        first_two_required = list(seed.values())[:2]
        if all(first_two_required):
            print(f"Auto-starting {kind} from env", flush=True)
            ch.set_config(seed)
        else:
            print(f"No env credentials for {kind} — bot disabled.", flush=True)

    # Loopback bind — Electron talks to this backend via 127.0.0.1.
    app.run(host="127.0.0.1", port=args.port)
