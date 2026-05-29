"""Channel protocol — shared interface every chat-platform module implements.

A channel encapsulates everything platform-specific: bot lifecycle, message
queueing, identity persistence, outbound send primitives, and log-redaction
regexes. `web_api.py` only ever talks to the abstract protocol through the
`registry.CHANNELS` dict.

Why a dataclass + Protocol instead of inheritance: per AGENTS.md we favor
composition. Each channel module produces an instance of the channel as a
module-level singleton and registers it. The `Channel` Protocol describes the
shape; concrete classes (TelegramChannel, SlackChannel, …) implement it
without sharing a base class.
"""

from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Iterable, Protocol, runtime_checkable

from .types import ChannelKind, QueueItem, SendResult


@runtime_checkable
class Channel(Protocol):
    """Every concrete channel module must satisfy this protocol.

    Lifecycle:
      - `set_config(config)` injects credentials and starts (or restarts) the
        bot inside its own daemon thread / asyncio loop. Mirrors the
        Telegram `/set-telegram-token` and Slack `/set-slack-tokens` flow.
      - `is_running()` reflects bot status (sentinel "starting" returns False
        to avoid races where outbound sends would crash).
      - `request_shutdown()` signals the event loop to exit gracefully. Used
        when credentials change so the new tokens take effect without a Flask
        restart.

    Identity persistence:
      - `load_persisted_identity()` reads the last-seen chat partner from disk
        (e.g. `.chat_id`, `.slack_user_id`).
      - `get_identity()` returns the cached/persisted identity.

    Outbound sends:
      - Each `send_*` accepts the renderer-side payload (see types.py) and
        returns a `SendResult`. The Flask routes are thin wrappers around
        these methods.

    Logging:
      - `redaction_patterns()` returns compiled regexes that should be
        scrubbed from log records globally. `_install_log_redaction()` in
        `web_api.py` unions them across all registered channels.
    """

    kind: ChannelKind

    # ── Lifecycle ────────────────────────────────────────────────────────
    def set_config(self, config: dict) -> dict: ...
    def is_running(self) -> bool: ...

    # ── Identity / queue ────────────────────────────────────────────────
    def get_identity(self) -> str | None: ...
    def poll(self) -> list[QueueItem]: ...
    def flush_pending(self) -> int: ...

    # ── Outbound sends ──────────────────────────────────────────────────
    def send_reply(self, payload: dict) -> SendResult: ...
    def send_update(self, payload: dict) -> SendResult: ...
    def send_photo(self, payload: dict) -> SendResult: ...
    def send_video(self, payload: dict) -> SendResult: ...
    def send_document(self, payload: dict) -> SendResult: ...
    def send_typing(self, payload: dict) -> SendResult: ...
    def send_keyboard(self, payload: dict) -> SendResult: ...

    # ── Logging ─────────────────────────────────────────────────────────
    def redaction_patterns(self) -> Iterable[re.Pattern[str]]: ...


class ChannelBase:
    """Optional convenience base — channel modules may inherit this for the
    common bookkeeping (pending-message queue, identity persistence file,
    daemon thread + asyncio shutdown event handle).

    Per AGENTS.md we prefer composition over inheritance, but this base does
    not define a hierarchy — it's just an opt-in bag of utilities. Subclasses
    are free to ignore it (the protocol is the contract).
    """

    def __init__(self, kind: ChannelKind, identity_file: Path) -> None:
        self.kind: ChannelKind = kind
        self._identity_file = identity_file
        self._pending: list[QueueItem] = []
        self._pending_lock = threading.Lock()
        self._start_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        # Bot-run state controlled by concrete subclasses (None | "starting" | bot).
        # Kept here so `is_running()` can be a one-liner across channels.
        self._app_instance: object | None = None

    # ── Pending queue helpers ────────────────────────────────────────────
    def queue_append(self, item: QueueItem) -> None:
        with self._pending_lock:
            self._pending.append(item)

    def poll(self) -> list[QueueItem]:
        with self._pending_lock:
            msgs = list(self._pending)
            self._pending.clear()
        return msgs

    def flush_pending(self) -> int:
        with self._pending_lock:
            count = len(self._pending)
            self._pending.clear()
        return count

    # ── Identity persistence ─────────────────────────────────────────────
    def load_persisted_identity(self) -> str | None:
        try:
            return self._identity_file.read_text().strip() or None
        except FileNotFoundError:
            return None

    def persist_identity(self, value: str) -> None:
        try:
            self._identity_file.write_text(value)
        except Exception:
            # Best-effort: filesystem issues should not crash the bot.
            pass

    # ── Lifecycle helpers ────────────────────────────────────────────────
    def is_running(self) -> bool:
        return self._app_instance is not None and self._app_instance != "starting"
