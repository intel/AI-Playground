# Proposal: Signal support as a Home Agent channel

Evaluation and implementation proposal for adding **Signal** as a Home Agent channel,
alongside the existing Telegram, Slack and LAN (`local-web`) channels.

> TL;DR
>
> - **Feasible, and the runtime model is closer to Telegram than Slack** (a single account
>   identity, a receive/poll loop, typing indicators, attachments — no Slack-style socket
>   mode, workspace, or app manifest). Slotting a `SignalChannel` into the existing
>   registry-driven architecture is mechanical.
> - **But Signal is fundamentally different from both in one way that dominates the design:
>   there is no hosted bot API.** You cannot "paste a token." Signal requires a *local
>   signal-cli process* bound to a real phone number, set up by **linking as a secondary
>   device (QR scan)** or registering a number (SMS/voice + CAPTCHA). That changes the setup
>   UX and adds a runtime dependency (a Java/native daemon), which is the real work here.
> - **One capability gap matters:** Signal has **no interactive inline keyboards/buttons**.
>   The app uses keyboards for image-gen preset pick, yes/no confirmations and history load.
>   These must degrade to **numbered-text menus + typed replies** (the dispatcher already
>   accepts typed yes/no for confirmations).
> - **Recommendation: ship in two phases.** Phase 1 targets an *external* signal-cli
>   JSON-RPC / REST endpoint the user runs (config = URL + account number) — proves the
>   channel end-to-end with zero bundling and zero licensing exposure. Phase 2 bundles
>   `signal-cli` as a managed sidecar with an in-app QR-link step so it's turnkey like
>   Telegram, pending a GPL-3.0 distribution decision.

---

## 1. How channels work today (both sides)

The channel system is deliberately registry-driven and channel-agnostic on both sides —
adding a platform is "one adapter + one registry entry", not edits scattered through the
message pipeline. `discord` is already stubbed as the template (`channels/registry.py:26`,
`channels/types.py:10`, and the renderer union).

**Python (`home-agent/`)** — the generic Flask layer only ever talks to an abstract
`Channel` protocol:

- `channels/base.py:29` — the `Channel` `Protocol`: `kind`, `set_config`, `is_running`,
  `get_identity`, `poll`, `flush_pending`, the eight `send_*` methods
  (`reply/update/photo/video/voice/document/typing/keyboard`) and `redaction_patterns`.
  `send_edit_message`/`send_history` are optional (dispatched dynamically). `ChannelBase`
  gives a thread-safe pending queue + identity persistence for free.
- `channels/registry.py:22` — `CHANNELS: dict[ChannelKind, Channel]`, the single source of
  truth for route dispatch.
- `web_api.py:189-244` — generic `POST /channel/<kind>/config`, `GET .../identity`,
  `GET .../poll`, `POST .../flush`, `POST .../send/<action>`. No per-channel code.
- `channels/commands.py:63` — `HOME_AGENT_COMMANDS`, the slash-command source of truth that
  drives Telegram's `set_my_commands` and Slack's `@command` handlers.
- `channels/actions.py:20` — `SEND_ACTIONS` allow-list (`camelCase → send_snake_case`).

**Renderer (`WebUI/src/`)** — the store drives a per-kind `ChannelAdapter` that just shapes
payloads and posts them to the generic bridge:

- `assets/js/store/channels/types.ts` — the `ChannelKind` union, per-kind `*ChannelConfig`,
  and `CHANNEL_FIELD_SPEC` (`requiredSecrets` + `identityField`; adding a kind is a compile
  error until filled in).
- `assets/js/store/channels/adapter.ts` — the `ChannelAdapter` contract (async
  `reply/photo/video/voice/document/keyboard/editKeyboardMessage`, typing heartbeat, draft
  stream, optional `replayHistory`, plus format hooks).
- `assets/js/store/channels/channelRegistry.ts` — `CHANNELS[]` descriptors (icon, display
  name, setup component, capabilities); the setup UI iterates this, never branches on kind.
- `assets/js/store/homeAgent.ts` — `KINDS` (~line 67), the four exhaustive `Record<ChannelKind,…>`
  maps (~169–206), activation/poll lifecycle, the command regexes + `HELP_MESSAGE` (~430–471),
  and the dispatcher (`processChannelMessages`/`drainCommonQueue`).
- `electron/subprocesses/homeAgentBackendService.ts` — a local `ChannelKind` mirror
  (line 16), `SECRET_FIELDS`/`PUBLIC_FIELDS`/`PASSPHRASE_FIELDS` maps (~87–109), and per-kind
  `test*`/`detect*` verifiers. `preload.ts`/`env.d.ts` are generic (`kind: string`) — no edit.

The upshot: the wiring for a new channel is well-trodden. **Signal's cost is not the wiring;
it's the transport.**

---

## 2. Why Signal is different from Telegram and Slack

| Concern | Telegram | Slack | **Signal** |
|---|---|---|---|
| Backend API | Hosted Bot API | Hosted Web API + Socket Mode | **None** — must run `signal-cli` locally |
| Python dep | `python-telegram-bot` (pip) | `slack-bolt` (pip) | pip client **+ a signal-cli daemon** (Java 25+ JRE or GraalVM native binary) |
| Credential | 1 bot token (from @BotFather) | 2 tokens (bot + app) | **Register a phone number** (SMS/voice + CAPTCHA) **or link as a secondary device (QR)** |
| Inbound | Long polling | WebSocket events | `receive` stream / poll (JSON-RPC or REST) — polling, **like Telegram** |
| Identity | `chatId` | `userId` | Bot's own account number + an allow-listed peer number |
| Interactive buttons | Inline keyboards ✅ | Block Kit actions ✅ | **None** ❌ → numbered-text fallback |
| Typing indicator | ✅ chat action | ⚠️ reactions hack | ✅ native (`sendTyping`) |
| Attachments (send/recv) | ✅ | ✅ | ✅ |
| Voice notes | ✅ (OGG/Opus) | ⚠️ audio file | ✅ (audio attachment / voice-note flag) |
| Message edit / draft stream | draft messages | `chat.update` | edit-by-timestamp; draft stream degrades to typing + final |
| Rich text | HTML | mrkdwn/Block Kit | style ranges / `**bold**` styled text |
| Slash-command menu | `set_my_commands` | app manifest | **none needed** — typed text parsed by the dispatcher (like `local-web`) |
| Setup UX analog | "paste a token" | "install an app + manifest" | **"scan a QR / run a daemon"** (closer to `local-web`'s "start a server") |

Two takeaways:

1. **At runtime, Signal behaves like Telegram** — poll for messages, one identity, native
   typing, attachments — and is actually *simpler* on the command surface (no `set_my_commands`,
   no Slack manifest; typed commands flow straight into the existing dispatcher, exactly like
   the LAN page).
2. **At bootstrap, Signal is unlike either** — it needs a local process and a phone-number
   link/registration. That is the entirety of the added difficulty and drives the phasing.

### 2.1 The interactive-keyboard gap (must handle)

`send_keyboard` is used by the pipeline for: image-gen **preset selection**, **yes/no
confirmations**, and **history load**. Signal has no buttons. Mitigation, in order of effort:

- **Confirmations** are already handled for keyboard-less channels: `processChannelMessages`
  intercepts a typed `yes`/`no` reply against a pending confirmation. Signal inherits this
  for free.
- **Preset / load menus**: render the options as a **numbered text list** and parse the
  reply (`1`, `2`, …). This is a small `SignalChannel.send_keyboard` transformation (buttons
  → text) plus reusing the existing callback semantics; no dispatcher rewrite.
- `editKeyboardMessage` (settling a prompt in place) becomes a follow-up text message.

---

## 3. Transport options evaluated

All three real options wrap the same core (`AsamK/signal-cli`, GPL-3.0, needs JRE 25+ or a
GraalVM native binary bundled for x86_64 Linux / Windows / macOS).

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **signal-cli JSON-RPC daemon** (`signal-cli daemon`, socket/TCP/HTTP) | One long-lived JVM/native process exposing JSON-RPC | Fastest; official; first-party; single process we can supervise like our other native backends | We manage the process + linking; JSON-RPC plumbing by hand |
| **signal-cli-rest-api** (`bbernhard`, Docker) | HTTP/Swagger wrapper around signal-cli (`/v2/send`, `/v1/receive/{number}`, `/v1/qrcodelink`, register/link) | Simple HTTP like the other backends; QR-link endpoint; well documented | **Docker-oriented** distribution — awkward to bundle in a desktop app; still GPL core |
| **signald** (socket daemon) | Alternative daemon | — | Less maintained than signal-cli; avoid |
| Python client libs | `signalbot`, `pysignalclirestapi` (both target the REST API); JSON-RPC clients | Save some plumbing | Add a dep whose backend is still the daemon; `signalbot` assumes the REST container |

**Recommendation:** target the **signal-cli JSON-RPC interface** as the canonical integration
(first-party, single supervisable process, no Docker). Phase 1 can point at *either* a
JSON-RPC daemon or a `signal-cli-rest-api` URL the user already runs, since both expose
send/receive/link — the `SignalChannel` abstracts it.

---

## 4. Proposed design

### 4.1 Phasing

- **Phase 1 — external endpoint (MVP, low risk, no bundling).**
  `SignalChannel` talks to a user-provided signal-cli JSON-RPC/REST endpoint. Config =
  `endpoint` URL + `account` (the linked/registered number) + optional allow-listed peer.
  The user links the device themselves (out of app). This proves the whole channel — adapter,
  routes, dispatcher, media, numbered-menu keyboard fallback — with **zero distribution or
  licensing exposure**. It is a pure additive feature, opt-in, dev-flag-gateable.

- **Phase 2 — bundled sidecar (turnkey).** Promote signal-cli to a managed backend in the
  service registry (like the native llama.cpp / OVMS servers): download the platform
  `signal-cli-native` binary on demand, supervise the daemon, and add an **in-app QR-link
  setup step** (render the QR from `link`/`/v1/qrcodelink`, poll until linked). Gated on the
  GPL-3.0 decision (§6) and per-platform native binaries (+ JRE fallback for unsupported
  arches).

### 4.2 Config shape

```ts
// types.ts — add to the union + CHANNEL_FIELD_SPEC
export type SignalChannelConfig = {
  kind: 'signal'
  account: string   // the bot's own Signal number, E.164 (e.g. +15551234567)
  endpoint: string  // Phase 1: signal-cli JSON-RPC/REST base URL (Phase 2: managed → localhost)
  peer?: string     // allow-listed sender (the owner's number); becomes the identity
}
// CHANNEL_FIELD_SPEC.signal = { requiredSecrets: ['account', 'endpoint'], identityField: 'peer' }
```

`endpoint`/`account` are treated as secrets (kept out of the persisted store, injected to the
backend via `set_config` like every other channel). `identityField: 'peer'` mirrors Telegram's
`chatId`.

### 4.3 `SignalChannel` (Python) → `Channel` protocol mapping

Mirror `telegram.py`'s shape (deferred import of the client lib so Flask boots without it;
`"starting"` sentinel; restart-on-config-change; daemon thread + receive loop that
`queue_append`s `QueueItem`s):

| Protocol method | Signal implementation |
|---|---|
| `set_config` | validate `account`/`endpoint`; (re)connect the receive loop |
| `poll`/`flush_pending` | inherited from `ChannelBase` (receive loop feeds the queue) |
| `get_identity` | the linked `account` (or confirmed `peer`) |
| `send_reply` | JSON-RPC `send` / REST `POST /v2/send` (styled text) |
| `send_update` | edit-by-timestamp if available, else no-op (draft stream degrades) |
| `send_photo/video/document` | `send` with base64 attachment |
| `send_voice` | audio attachment (reuse `channels/audio.py`; voice-note flag if supported) |
| `send_typing` | `sendTyping` / `POST /v1/typing-indicator` |
| `send_keyboard` | **buttons → numbered text list** (see §2.1); returns a synthetic ref |
| `redaction_patterns` | redact the account number / endpoint auth from logs |

Inbound: authorize on sender == `peer`; download attachments → base64 → `RemoteImage/Audio/Document`;
typed text (incl. `/help`, `/imgGen`, `yes`/`no`) flows into the existing dispatcher unchanged.

### 4.4 Setup UX

Closer to `local-web` than Telegram: not "paste a token" but "connect an account."
`SignalSetupSteps.vue` (registry-driven, hardcoded English strings — the channel UI is not
i18n'd today):

- **Phase 1:** fields for `endpoint` + `account` (+ optional `peer`), a "Verify" button that
  calls the backend `testSignal()` (a `send`-to-self or a `receive` handshake), then
  `setVerified`.
- **Phase 2:** a "Link device" step that displays the QR from signal-cli and polls until the
  link completes — analogous to `local-web`'s "save & start server" flow.

---

## 5. Exact touch points

Additive; `discord` (already stubbed) is the working reference. `preload.ts`, `env.d.ts`,
`main.ts`, `HomeAgentSetupPage.vue`, `HomeAgentToggle.vue` need **no edits** (generic /
registry-driven). No i18n changes (channel UI uses hardcoded strings today).

### Python (`home-agent/`)

| File | Change |
|---|---|
| `channels/signal.py` | **NEW** — `SignalChannel(ChannelBase)` per §4.3 |
| `channels/types.py:10-16` | add `"signal"` to `ChannelKind` + `ALL_CHANNEL_KINDS`; add `SignalConfig` TypedDict |
| `channels/registry.py:14,22` | import + `"signal": SignalChannel(_BASE_DIR)` |
| `pyproject.toml` | add the Signal client dep; **regenerate `uv.lock`** (`uv lock`) |
| `channels/audio.py` | only if a Signal-specific voice transcode is needed |
| `web_api.py:278-302` | optional `_env_seeds` entry for dev/CLI auto-start |
| `channels/commands.py`, `channels/actions.py` | **no change** (commands reuse as-is; no new outbound action) |
| `tests/test_signal_channel.py` | **NEW (recommended)** — mirror `test_local_web_channel.py`; assert every `SEND_ACTIONS` resolves + config/restart behavior |

### Renderer + Electron main (`WebUI/`)

| File | Change |
|---|---|
| `src/assets/js/store/channels/types.ts` | add `'signal'` to `ChannelKind`, `SignalChannelConfig`, `ChannelConfig` union, `CHANNEL_FIELD_SPEC.signal` (compile-forced) |
| `src/assets/js/store/channels/signalAdapter.ts` | **NEW** — `createSignalAdapter()` wrapping `channel.send('signal', …)`; reuse `adapterHelpers`; buttons→text |
| `src/assets/js/signalMarkdown.ts` | **NEW (optional)** — markdown → Signal styled text, else plain text |
| `src/assets/js/store/homeAgent.ts` | import adapter; add `'signal'` to `KINDS`; add `signal:` to the four `Record<ChannelKind,…>` maps (prefs/channels/queues/adapters) |
| `src/assets/js/store/useSignalSetup.ts` | **NEW** — composable (model on `useTelegramSetup`, or `useLocalWebSetup` for the non-token flow) |
| `src/components/SignalSetupSteps.vue` | **NEW** — setup UI (+ Phase 2 QR-link step) |
| `src/assets/js/store/channels/channelRegistry.ts` | add `SignalIcon`, `useSignalSetup` to `ChannelSetupComposable`, async `SignalSetupSteps`, and the `CHANNELS[]` entry |
| `electron/subprocesses/homeAgentBackendService.ts:16,87-109,717` | add `'signal'` to the `ChannelKind` mirror + `SECRET_FIELDS`/`PUBLIC_FIELDS`/`PASSPHRASE_FIELDS`; add `testSignal()` + a `channelTest` branch |
| `electron/test/channels/adapters.test.ts` | add a `createSignalAdapter` block |
| `electron/logging/logger.ts` | optional — redact Signal account/endpoint if they leak to logs |

### Phase 2 only (packaging)

| File | Change |
|---|---|
| `electron/subprocesses/signalCliService.ts` (+ `apiServiceRegistry.ts`, `external/backend-versions.json`) | **NEW** managed backend: download `signal-cli-native` per platform, supervise the daemon, health check |
| `3rdpartynoticeslicenses.txt` / notices | add signal-cli (GPL-3.0) attribution once the licensing decision lands |

---

## 6. Risks & open questions

1. **Licensing (blocker for bundling).** `signal-cli` is **GPL-3.0**. Distributing it with
   the app has copyleft implications that must be reviewed before Phase 2. Phase 1 (user runs
   their own endpoint) side-steps this entirely.
2. **Runtime weight.** signal-cli needs JRE 25+ (or a GraalVM native binary, prebuilt only
   for x86_64 Linux / Windows / macOS). Windows + Intel is the primary shipping target; verify
   the native Windows binary, else bundle a JRE (heavy).
3. **Registration/linking friction.** Unlike a token paste, the user must link a device (QR)
   or register a number (SMS/voice + CAPTCHA). This is inherent to Signal; the QR-link path is
   the least painful and should be the documented default.
4. **No interactive buttons.** Handled via numbered-text fallback (§2.1), but preset/history
   menus are less slick than on Telegram/Slack — acceptable, worth calling out in the UI.
5. **signal-cli currency.** Signal clients expire ~3 months; a bundled binary needs a refresh
   path (the existing `backend-versions.json` + on-demand download model covers this).
6. **Draft streaming.** Live "typing out the answer" may not be supported cleanly; degrade to
   a typing indicator + a single final message (still a good UX).

---

## 7. Recommendation & effort

**Proceed, Phase 1 first.** It is a clean, additive, low-risk feature that reuses the entire
existing pipeline and delivers a working Signal channel against a user-run signal-cli
endpoint, with no bundling or licensing exposure. Treat Phase 2 (bundled turnkey sidecar +
QR-link UI) as a follow-up gated on the GPL-3.0 review and per-platform native binaries.

Rough effort (excludes Phase 2 packaging):

| Area | Estimate |
|---|---|
| `SignalChannel` (send_*/receive loop, JSON-RPC client, keyboard→text) + tests | ~2–3 days |
| Renderer adapter + store wiring + `homeAgentBackendService` maps/verify | ~1–2 days |
| `SignalSetupSteps.vue` + `useSignalSetup` (Phase 1 form + verify) | ~1 day |
| Docs + manual verification via the dev **mock channel** and a live endpoint | ~1 day |

Phase 2 (managed sidecar download/supervision + QR-link step + licensing/notices) is a
separate, larger effort of its own.
