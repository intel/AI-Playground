"""Single source of truth for Home Agent slash commands.

Both channel transports (`telegram.py`, `slack.py`) build their command
handlers and platform command menus from `HOME_AGENT_COMMANDS`, so a command
can never be wired into one transport but silently forgotten in another (the
class of bug where `/reset` worked in the dispatcher but was never registered
with Telegram or Slack).

This list only governs how a *transport* recognizes a slash command and what
raw text it forwards. Two further, TypeScript-side touch-points are NOT covered
here and must be kept in sync by hand — see AGENTS.md "Home Agent slash
commands" for the full checklist:

  * the dispatcher + `HELP_MESSAGE` in `WebUI/src/assets/js/store/homeAgent.ts`
    (the actual per-command behavior), and
  * the Slack app manifest in `WebUI/src/components/SlackSetupSteps.vue`
    (`slash_commands`), which the user copies into Slack.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HomeAgentCommand:
    """One slash command, described once for every channel transport.

    name:             canonical lowercase trigger. Slack slash commands must be
                      lowercase, and Telegram's command menu must be lowercase.
    description:      shown in the Telegram command menu / Slack manifest.
    takes_args:       whether free text after the command is forwarded along.
    queued:           the exact text handed to the renderer-side dispatcher.
                      Defaults to ``/<name>``; override when the dispatcher
                      expects a different spelling (e.g. ``/imgGen``).
    telegram_aliases: extra Telegram-only trigger spellings that resolve to the
                      same command (e.g. ``imgGen`` for camelCase parity, or
                      ``start`` -> help). These never appear in the menu.
    """

    name: str
    description: str
    takes_args: bool = False
    queued: str | None = None
    telegram_aliases: tuple[str, ...] = ()

    @property
    def queued_text(self) -> str:
        return self.queued if self.queued is not None else f"/{self.name}"

    @property
    def slash(self) -> str:
        return f"/{self.name}"

    def build_full_text(self, args: list[str] | None) -> str:
        """Assemble the text forwarded to the dispatcher for this invocation."""
        if self.takes_args and args:
            return f"{self.queued_text} {' '.join(args)}".strip()
        return self.queued_text


# Order is preserved for the Telegram command menu and the Slack manifest.
HOME_AGENT_COMMANDS: tuple[HomeAgentCommand, ...] = (
    HomeAgentCommand("help", "Show available commands", telegram_aliases=("start",)),
    HomeAgentCommand("chat", "Force a text chat reply (no image generation)", takes_args=True),
    HomeAgentCommand(
        "imggen",
        "Pick a preset and generate an image",
        takes_args=True,
        queued="/imgGen",
        telegram_aliases=("imgGen",),
    ),
    HomeAgentCommand("cancel", "Cancel a pending image-generation prompt"),
    HomeAgentCommand("new", "Start a new Home Agent chat thread"),
    HomeAgentCommand("history", "List your saved Home Agent chats"),
    HomeAgentCommand("load", "Resume a chat (no id = pick from menu)", takes_args=True),
    HomeAgentCommand("reset", "Restore Home Agent settings to defaults"),
)
