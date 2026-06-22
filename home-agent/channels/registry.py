"""Concrete channel instances keyed by ChannelKind.

`CHANNELS` is the source of truth for generic `/channel/<kind>/*` route
dispatch in `web_api.py`. Adding a new platform = adding one entry here.
"""

from __future__ import annotations

from pathlib import Path

from .base import Channel
from .slack import SlackChannel
from .telegram import TelegramChannel
from .types import ChannelKind


_BASE_DIR = Path(__file__).resolve().parent.parent


# Module-level singletons. Constructing them at import time is safe — none of
# them start their bot until `set_config()` is called.
CHANNELS: dict[ChannelKind, Channel] = {
    "telegram": TelegramChannel(_BASE_DIR),
    "slack": SlackChannel(_BASE_DIR),
    # "discord": DiscordChannel(_BASE_DIR),  # follow-up PR
}


def get(kind: str) -> Channel | None:
    """Lookup helper used by the Flask layer; returns None for unknown kinds."""
    return CHANNELS.get(kind)  # type: ignore[arg-type]
