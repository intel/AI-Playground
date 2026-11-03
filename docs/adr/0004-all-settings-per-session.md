---
status: accepted
supersedes: ADR-0001
---

# Every preset's settings are per Session

ADR-0001 gave only the Agent preset Session Settings, because the other presets' sessions were short-lived and preset-driven. Now that one Session spans presets, a preset's settings follow the Session for every preset: the first time a preset runs in a Session it copies its Default Settings, and returning to that preset later in the same Session restores what the Session last used (Image Gen → Agent → Image Gen keeps the seed). Save as default and Reset to default exist for every preset. ADR-0001's repair rules carry over unchanged: settings that came from the defaults are repaired silently, a Session's own unusable settings block sending until the user fixes them. Machine-level settings — backend install, device, developer toggles — and the TTS voice stay global.
