"""Python mirror of WebUI/src/assets/js/store/channels/types.ts.

These are pure data shapes (TypedDicts and Literals) used by the channel
modules and the generic Flask routes. Keeping them centralized makes it easy
to spot a contract drift between renderer and backend.
"""

from typing import Literal, TypedDict

ChannelKind = Literal["telegram", "slack", "discord"]
ALL_CHANNEL_KINDS: tuple[ChannelKind, ...] = ("telegram", "slack", "discord")


class TelegramConfig(TypedDict, total=False):
    kind: ChannelKind  # "telegram"
    token: str
    chatId: str


class SlackConfig(TypedDict, total=False):
    kind: ChannelKind  # "slack"
    botToken: str
    appToken: str
    userId: str


class DiscordConfig(TypedDict, total=False):
    kind: ChannelKind  # "discord"
    botToken: str
    userId: str


class RemoteImage(TypedDict):
    mime: str
    data_base64: str


class QueueItem(TypedDict, total=False):
    text: str
    images: list[RemoteImage]
    callback: str
    chat_id: str
    channel: str
    ts: str


class SendResult(TypedDict, total=False):
    status: str
    ts: str
    channel: str
    error: str
