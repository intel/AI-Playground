---
status: superseded by ADR-0004
---

# Agent settings are per session; stored settings block, defaults repair

The Agent preset's settings (backend, device, model, context size, thinking, capabilities, …) used to be one bag per preset, so changing them in one Agent Session changed every session. Each Agent Session now stores its own Session Settings, and the preset's saved bag became the Default Settings that a new Draft Session copies. Only the Agent preset works this way: Game Agent, Quick Coder and the chat presets keep one bag per preset, because their sessions are short-lived and preset-driven. The chat store keeps the live controls; the agent store binds them to the active session (`textInference.bindSessionSettings`), so the shared controls did not have to be duplicated.

## Considered Options

- **Live fallback to the defaults for missing fields** — rejected: older sessions would keep following the defaults, which is the bug being fixed. A missing field is filled once and stored.
- **Silently repair a sent session's unusable settings** (today's preset behaviour) — rejected: it changes what the user chose for that session without telling them. Sending is blocked until the user fixes it. Settings that come from the defaults (a new draft, "Reset to default") are still repaired silently, because the user has not chosen them for this session yet.
