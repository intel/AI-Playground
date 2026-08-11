"""Outbound send actions, and how each maps to a channel method.

The renderer names actions after the adapter methods that produce them, so they are
camelCase; the channel modules implement snake_case methods. That difference only
shows up for `editMessage` — every other action happens to be a single lowercase
word — which is exactly why it went unnoticed: `send_editMessage` matched nothing,
so settling an interactive prompt in place silently 404ed on every channel.

Kept here rather than in `web_api.py` so the contract sits with the channels,
dispatch happens against a known set instead of probing attribute names, and both
can be tested without importing Flask.

MUST stay in sync with the action union in `ChannelAdapter` / `preload.ts`.
"""

from __future__ import annotations

import re

SEND_ACTIONS: tuple[str, ...] = (
    "reply",
    "update",
    "photo",
    "video",
    "voice",
    "document",
    "typing",
    "keyboard",
    "editMessage",
    "history",
)


def send_method_name(action: str) -> str | None:
    """Method implementing `action`, or None when `action` isn't one we know."""
    if action not in SEND_ACTIONS:
        return None
    return "send_" + re.sub(r"(?<!^)(?=[A-Z])", "_", action).lower()
