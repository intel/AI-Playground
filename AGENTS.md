# AGENTS.md — AI Playground

Concise reference for AI coding agents working in this repository.

## Project Overview

Electron + Vue.js desktop app for AI inference on Intel GPUs. Multi-process architecture:
Electron main process orchestrates Vue.js frontend and multiple Python/native backend services
(AI Backend, ComfyUI, LlamaCPP, OpenVINO). Frontend code lives in `WebUI/`.

## Mandatory Rules

- Use **composition over inheritance** — never introduce new class hierarchies.
- Do **not** use classes unless extending an existing set of classes of the same type.
- Use **`type`** instead of `interface`, unless an interface is strictly necessary for implementation.
- **Comment only when it is extremely important**, and keep it to one line where possible.
  See [Comments](#comments).
- **Never auto-download model weights.** Installing a backend (its `set_up()`) installs only the
  runtime/dependencies (torch, servers, etc.) — **never** model weights. Weights download **on
  demand**, only when the user has selected a preset/engine **and** actually tries to use it, via
  the shared download dialog (`dialogs.showDownloadDialog`). Mirror the existing pattern:
  `qwen3TextToSpeech.ensureModelInstalled`, `speechToText.ensureWhisperReady` /
  `ensureStandaloneReady` — check `models.checkTranscriptionModelExists(...)` /
  `getMissing...Model(...)`, then prompt. Selecting an engine in settings must not trigger a
  download, and Python sidecars run with `HF_HUB_OFFLINE=1` so they can't silently fetch.

## Build / Dev / Test Commands

All commands run from the **`WebUI/`** directory.

```bash
# Install dependencies
npm install

# Build native addons (better-sqlite3) for Electron's ABI — runs from predev too.
# Without it the persistent-memory capability reports itself unavailable.
npm run ensure-native-modules

# Start dev server + Electron
npm run dev

# Run all tests once
npm test

# Pi coding-agent integration smoke (no model call)
npm run verify:pi

# Run tests in watch mode
npm run test:watch

# Run a single test file
npx vitest run electron/test/subprocesses/deviceArch.test.ts

# Run tests matching a name pattern
npx vitest run --testNamePattern "getDeviceArch"

# Lint (ESLint with auto-fix)
npm run lint

# Lint without auto-fix (CI mode)
npm run lint:ci

# Format (Prettier)
npm run format

# Format check only (CI mode)
npm run format:ci

# TypeScript type-check (no emit)
npx vue-tsc --noEmit

# Full production build (Windows installer)
npm run fetch-external-resources
npm run build
```

Python is linted with **Ruff** (`ruff check` / `ruff format`, whole-repo config in `ruff.toml`)
and scanned with **Bandit** (scope in `bandit.yaml`). Both run in CI and are reproducible from
`WebUI/` via npm — the scripts shell out to `uvx` with the same pinned versions CI uses, so no
local Python install is needed:

```bash
npm run lint:python   # both of the below
npm run lint:ruff     # ruff check + ruff format --check, whole repo
npm run lint:bandit   # bandit security scan, whole repo
```

Its tests are stdlib `unittest`, no pytest needed:

```bash
python -m unittest discover -s home-agent/tests   # Home Agent channels (real sockets, ~5s)
python -m unittest discover -s service/tests      # model-management backend
```

## Test Conventions

- Framework: **Vitest 3.2+** with `node` environment.
- Test file pattern: `**/*.test.ts` (not `.spec.ts`).
- Path aliases: `@` → `./src`, `electron` → `./electron`.
- Tests use `describe` / `it` / `expect`. Mock Electron with `vi.mock('electron', ...)`.
- Tests live alongside source in `electron/test/` (currently unit tests for Electron main process only).

### E2E tests (Playwright, real Electron) — `WebUI/e2e/`

Drives the **real compiled Electron app** (not a mocked renderer) and actually installs
backends, so runs take minutes. Separate from Vitest: `.spec.ts` files, config
`playwright-e2e.config.ts`. Two scripts: `npm run e2e:fast` runs only the quick agentic smoke
(`agentic-smoke.spec.ts` — install + a haiku text turn + one image turn); `npm run e2e:full`
runs the whole suite — the full agentic reference flow (`assistant-media-flow.spec.ts`, image →
edit → video) plus one smoke test per chat/image/video preset in `preset-*.spec.ts` — and
excludes the quick smoke (`--grep-invert "Agentic smoke"`) so backends aren't installed twice.

**"Smoke test" means `npm run e2e:fast`.** When a change asks to be smoke-tested — a
dependency bump, a backend change, anything whose breakage a unit test wouldn't catch —
run it yourself and report the result. Do not ask the user to run it, and do not
substitute `npm test` or a `--list` dry run for it.

**Architecture:** `vite --mode test` serves only the renderer (the Electron plugin is
skipped in test mode — see `vite.config.mts`); the fixture launches the built Electron
main (`dist/main`, built on demand) pointed at that dev server via `VITE_DEV_SERVER_URL`.

**Only one instance of the app can run at a time** — a single-instance lock (a named
mutex on Windows) makes a second launch attach to the existing instance instead of
starting fresh. The suite never runs the app in parallel: it is serial (`workers: 1`,
`fullyParallel: false`) and each test launches then closes its own Electron.

**Required before every e2e run — check nothing is already running, and close it if it is:**

```bash
# Windows: any Electron (dev instance, packaged app, orphan from a killed run)
tasklist | grep -i electron
# and the test dev server
netstat -ano | grep LISTEN | grep -E ':(5173|25413)'
```

Never start an e2e run while a dev/app instance is up, and never run two test invocations
concurrently — not two e2e runs, and not an e2e run alongside a manually launched app. The
second one attaches to the first instead of starting fresh, and both behave wrongly. A
not-fully-reaped Electron from a previous run causes the same thing: the next launch
attaches and quits with no window ("No Electron windows appeared"). The launch fixture
retries once to ride out that flake, but it cannot recover from a live instance you left
running. **If the app starts with an empty/blank window and the console shows
`chrome-error://chromewebdata` failing to load `127.0.0.1:<port>`, that is this bug** — the
renderer attached to an instance whose dev server is gone. Close every Electron process and
relaunch.

**Files:** `fixtures.ts` (launch + `window`/`app` fixtures), `appDriver.ts` (`AppDriver`,
the high-level entry point; exposes `wizard`, `shell`, `main`, `settings`), `pages/*.ts`
(Page Objects: `SetupWizardPage`, `AppShellPage`, `MainPage` = prompt area + results,
`SpecificSettingsPage` = the preset settings sidebar, `HomeAgentPage` = Home Agent setup +
title-bar master toggle), `backends.ts` (parametric model + types), `helpers.ts`,
`agentic-smoke.spec.ts` (quick `e2e` gate), `assistant-media-flow.spec.ts` (full agentic
reference spec: install + image → edit → video), and for the LAN chat channel
`localWebBrowser.ts` (drives the _served page_ in a real BrowserWindow, so a break in the
page's own JS — login, EventSource, send, reply/media rendering — is caught) and
`home-agent-local-web.spec.ts`.

**Rules:**

- **Start every test with the shared setup method:** `await app.installAllBackends()`. It's
  idempotent (handles fresh-wizard and already-running starts) and is where reusable setup
  belongs. Keep flows on the driver / page objects, not inlined in specs.
- **Selectors = interact like a user: role + accessible name/text only.** Use `getByRole`,
  `getByText`, `getByLabel`. **No test-ids, no CSS classes/`#id`, no xpath/ancestor walking.**
  If an element has no accessible name (icon-only buttons, anonymous rows), **add minimal
  ARIA to the app component** (`role="group"`+`aria-label`, `title`/`aria-label` on the
  control) — a real a11y improvement, not a test hook. See `SetupWizardRow.vue`,
  `BackendOptions.vue`.
- **Parametric over per-element.** Backends share one row component; locate a backend's
  toggle/gear/menu by unique accessible name (`Enable <name>`, `<name> options`).
- **Type backend params, never `string`.** Use `BackendDisplayName` from `backends.ts`,
  derived from the app's `BackendServiceName` union via `satisfies Record<...>` (so
  adding/removing a backend is a compile error here). Import app **types only**
  (`import type`) — erased at runtime, pulls in no app deps.
- **Use `test.step(...)`** to label sections.
- **Fresh app per test** (fixture launches+closes Electron each test): don't depend on
  prior-test state and don't over-engineer end-of-test cleanup.
- **Use long timeouts** for install/update waits (`SetupWizardPage.INSTALL_TIMEOUT`).

**Domain gotchas (learned the hard way):**

- Installing is **one button**: enable each backend's toggle, then click **"Install &
  Continue"** — there are no per-backend install buttons.
- **Deactivate a backend with its toggle.** For "no Home Agent",
  `wizard.disableBackend('Home Agent')`.
- **Re-disable on every wizard open** — reopening reseeds install selection and re-enables
  installed backends, so a toggled-off backend comes back on.
- **Home Agent left enabled diverts the wizard** to its setup page after install instead of
  the running app (a common cause of downstream click timeouts).
- **NVIDIA mode:** OpenVINO is unavailable (dimmed row, disabled toggle) — skip such
  backends via `wizard.isAvailable(name)`.
- **Version updates** live in the per-backend gear menu as "Update to <version>", shown only
  when installed ≠ pinned target.
- **"Agentic mode" isn't a UI mode** — it's Chat mode with a tool-enabled chat preset (e.g.
  "Agentic Chat"), which lets the assistant generate/edit images and video from a prompt.
  Select it via `SpecificSettingsPage` (preset cards are `role="button"`, name = preset name).
- **Turn completion:** the Send button (`aria-label="Send"`) is removed while a turn runs and
  returns when done — `MainPage.waitUntilIdle(timeout)` waits on that (image/video runs take
  minutes; use `IMAGE_TIMEOUT`/`VIDEO_TIMEOUT`). Result assertions use ARIA added to outputs:
  generated images `alt="Generated result"` (count via `getByRole('img', …)`), videos via
  `locator('video')`, 3D models `aria-label="Generated 3D model"`, assistant text via
  `getByRole('article', { name: 'Assistant response' })`. Both the agentic chat tool card
  (`ChatWorkflowResult.vue`) and the direct Image Gen/Edit/Video panel (`WorkflowResult.vue`)
  carry the same output ARIA, so one locator covers both surfaces.
- **Per-preset smoke tests** (`preset-chat/image/video.spec.ts`) are data-driven: each selects
  one preset via `AppDriver.runChatPreset`/`runComfyPreset`, which `test.skip`s presets absent
  in the running product mode. Reference-image presets load `e2e/fixtures/input.png` into the
  settings-sidebar `LoadImage` inputs (accessible name = the field label); chat vision/RAG
  presets attach a fixture via the prompt-area "+" input (`aria-label="Attach image or document"`).
- **Settings sidebar re-opens** when returning from the wizard and can occlude controls;
  `openAppSettings()` is idempotent. Playwright "visible" ignores occlusion.
- **Optional popups intercept clicks.** The high-memory / video-VRAM warning (`WarningDialog`,
  `role="dialog"` + `aria-label="Warning"`) fires whenever a gated preset becomes active —
  _including just switching to a mode whose last-used preset is gated_ — so it can appear
  before any step you control and its backdrop then eats clicks. Handle it globally with
  `page.addLocatorHandler` (registered in the `window` fixture), scoped by message so it
  never touches unrelated warnings; the handler ticks "Do not show again" and confirms.
- **First use of a preset downloads its models.** On a fresh machine almost every preset
  (chat/image/video) opens the blocking model-download dialog (`DownloadDialog`,
  `role="dialog"` + `aria-label="Model download"`) on the first send/generate. `AppDriver`
  clears it via `DownloadDialogPage.resolve()` at every send point; gated models with no HF
  access can't be confirmed, so those tests `test.skip` instead of hanging.
- **Timeouts:** the default chat model (Qwen3.5-9B) is a _reasoning_ model — its thinking
  alone can exceed 2 min, so per-turn budgets are minutes (`TEXT/IMAGE/VIDEO_TIMEOUT`), applied
  _after_ any model download is handled separately.
- **"Close" is ambiguous** — the header's window-close (X) control is `title="Close"`, so an
  unscoped `getByRole('button', { name: 'Close' })` can match it and **quit the app**. Scope
  sidebar closes to their region (`getByRole('region', { name: '<title>' })`, via
  `SideModalBase`'s `role="region"`), and prefer a uniquely-named button (e.g. the wizard's
  "Continue") over "Close".
- **Channel config outlives the test run** (it is stored in `safeStorage`, not in the app
  window), so a channel setting is only what this test asserts if the test _drives it to the
  value it wants_ — `configureLocalWeb` unchecks LAN access when it wasn't asked for, rather
  than only checking it.
- **The LAN chat page repaints itself** on `/new` (clean slate) and `/load` (the chosen
  thread's transcript), because it keeps no history of its own. Counting reply bubbles
  therefore cannot detect completion of those commands — the repaint drops the bubbles you
  counted; wait for the reply's text (`sendAndAwaitText`) instead. Its bubbles are named by
  role: `Your message`, `Home Agent response` (settled), `Home Agent draft` (streaming),
  `Home Agent prompt` (awaiting a tap), plus `role="status"` while typing — so "wait for the
  reply" never settles on a draft or a question.
- **`addLocatorHandler` requires the trigger to disappear.** Playwright re-checks that the
  element which triggered a handler is gone before continuing, so a handler for something
  that stays on screen fails the action that triggered it. The LAN page retires a prompt's
  buttons once tapped, which is what makes its auto-confirm handler safe; anything that
  lingers needs `noWaitAfter: true`. Beware too that _any_ action or assertion triggers a
  registered handler — asserting a prompt is visible can consume it.

**Before claiming it works:** `npm run typecheck` (`vue-tsc`; `e2e/` is in the root
`tsconfig.json`) and a cheap no-launch smoke: `npx playwright test --config
playwright-e2e.config.ts --list`. 

## Code Style

### Comments

Default to none. Write one only when a reader would otherwise get it wrong — a non-obvious
constraint, a workaround for external behaviour, or why an obvious approach was rejected.
Then keep it to a line or two. Do not restate what the code says, narrate a change, or
explain a tool's documented behaviour.

### Formatting (enforced by Prettier + EditorConfig)

- **No semicolons**
- **Single quotes**
- **2-space indentation** (spaces, not tabs)
- **100-character line width**
- **LF line endings**
- **Trailing whitespace trimmed**, final newline inserted

### TypeScript

- Target: **ES2023**, module: **ESNext** with bundler resolution.
- **Strict mode** enabled.
- Prefix unused variables/parameters with `_` (e.g., `_event`, `_unused`).
  Variables ending in `Schema` are also exempt from unused-var checks.
- Use `type` over `interface` (see Mandatory Rules above).

### Vue Components

- Always use `<script setup lang="ts">` with Composition API.
- Define props with `defineProps<{ ... }>()` using TypeScript generics.
- Define emits with `defineEmits<{ ... }>()` using TypeScript generics.
- File naming: **PascalCase** (`MyComponent.vue`).
- Single-word component names are allowed (`vue/multi-word-component-names` is off).

### Icons

Prefer Heroicons (`@heroicons/vue/24/outline` or `24/solid`) for new UI. Do not add a custom
mask to `src/assets/css/svg.css` unless the glyph is missing from Heroicons. Existing
`.svg-icon` sprites stay for older chrome.

### Tooltips

Use the shadcn wrappers in `src/components/ui/tooltip` (`TooltipProvider` / `Tooltip` /
`TooltipTrigger` / `TooltipContent`). Do not use the native `title` attribute for new hover copy.

- One `TooltipProvider` around the region that owns the tips. Put `:delay-duration="200"` on it —
  that is the delay `IconButton` and the settings/wizard icon tips already use.
- Instant (`0`) is only for labels that sit on a live control whose meaning must appear with no
  wait (the prompt-bar status chips).
- `TooltipTrigger` takes `as-child` wrapping the actual control. Keep an `aria-label` on that
  control when the visible text is not the tip.

### Pinia Stores

- Use setup syntax: `defineStore('name', () => { ... })`.
- Enable persistence with `{ persist: true }` option where needed. Properties picked for persistence need to be returned, even if they are not used externally.
- Add HMR support: `if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(...))`.
- **HMR would eat plain-object state**: Pinia's hot-update merge skips every entry of a
  `ref<Record<…>>` (its `patchObject` only keeps keys the freshly created store already has), and
  the persistence plugin saves the emptied map straight after the swap — editing a store file with
  the dev server running used to permanently delete agent sessions, chat conversations and the
  per-preset settings maps. `preserveStateAcrossHmr`
  (`src/assets/js/piniaHmrStatePreservation.ts`, registered in `main.ts`) re-applies the old
  entries during the update. It is inert in production builds, which have no hot update hook.
- Store files: **camelCase** in `WebUI/src/assets/js/store/` (e.g., `backendServices.ts`).
- Store hooks use `use` prefix: `useBackendServices`, `useTextInference`.
- Stores may import other stores for composition.
- **Store instantiation**: Always use a regular `import` at the top of the file and call `const someStore = useSomeStore()` at the top of the `defineStore` setup function or `<script setup>` block. **Never** use dynamic `import()` or inline `useSomeStore()` calls inside nested functions/callbacks.

### Import Ordering

No strict enforcement, but follow the prevailing convention:

1. External packages (`vue`, `pinia`, `zod`, `@ai-sdk/*`)
2. Internal stores (`@/assets/js/store/...`)
3. Components (`@/components/...`)
4. Utilities (`@/lib/utils`, `@/assets/js/toast`)

### Naming Conventions

| Element               | Convention   | Example                             |
| --------------------- | ------------ | ----------------------------------- |
| Vue components/files  | PascalCase   | `ModelSelector.vue`                 |
| Store files           | camelCase    | `backendServices.ts`                |
| Functions/variables   | camelCase    | `startService`, `currentStatus`     |
| Types                 | PascalCase   | `BackendStatus`, `ModelPaths`       |
| Store composables     | `use` prefix | `useBackendServices()`              |
| Backend service names | kebab-case   | `'ai-backend'`, `'comfyui-backend'` |
| Python modules        | snake_case   | `web_api.py`, `llm_biz.py`          |

### Error Handling

The renderer has a **single error sink**: the `errors` store (`useErrors`). All errors flow
through it — never surface errors ad hoc.

- Wrap async operations in `try/catch`.
- **Report through the sink, not directly**: `import { useErrors } from '@/assets/js/store/errors'`
  then `errors.report(err, { ... })`. Do **not** call `toast.error(...)` for error paths and do
  **not** rely on bare `console.error()` — the sink logs, de-duplicates, and decides how to surface.
- For new, well-defined failures, build a typed `AppError` with
  `createAppError({ category, code, userMessage, surface, ... })`
  (`@/assets/js/errors/appError.ts`) and pass it to `errors.report(...)`. Unknown values
  (caught `unknown`, rejected promises) can be passed straight to `errors.report(value, overrides)`
  and are normalized automatically.
- `surface` controls UX: `'toast'` (default for user-facing), `'inline'`, `'modal'`, or `'silent'`
  (log/track only — use for background work like Home Agent threads, or when another layer already
  shows the message). `severity` is `'info' | 'warn' | 'error' | 'fatal'`.
- Global capture is wired in `main.ts` (Vue `errorHandler`, `unhandledrejection`, `window.error`),
  so uncaught failures already reach the sink. De-duplication keys off the `AppError` instance, so
  re-`report`ing the same caught error (e.g. rethrown then caught again) won't double-toast.
- IPC handlers (main → renderer) still return `{ success: boolean, error?: string }`; the renderer
  turns a failed result into an `AppError` via the sink.
- Python backends: return `{"code": 0, "data": ...}` on success, `{"code": -1, "message": ...}` on error.

## ESLint Rules of Note

- `vue/multi-word-component-names`: **off**
- `vue/require-v-for-key`: **warn**
- `vue/no-use-v-if-with-v-for`: **warn**
- `@typescript-eslint/no-this-alias`: **warn**
- `@typescript-eslint/no-unused-vars`: **error** (unused prefixed with `_` are ignored)

## Key Directories

```
WebUI/                      # Electron + Vue.js frontend (all npm commands here)
  electron/                 # Electron main process (IPC, service registry, preload)
    subprocesses/           # Backend service classes + langchain utility process
  src/                      # Vue.js app (components, views, stores, utils)
    assets/js/store/        # Pinia stores (domain + implementation)
    assets/js/errors/       # Unified error model (AppError type + createAppError/normalize helpers)
    assets/js/activities/   # Unified activity/progress model (Activity type + createActivity helper)
    components/             # Reusable Vue components
    views/                  # Page-level Vue components (Chat, PromptArea, WorkflowResult)
  external/                 # Presets, workflows, external resources
service/                    # Python Flask backend (model download/management, NOT inference)
LlamaCPP/                   # LlamaCPP inference backend
OpenVINO/                   # OpenVINO inference backend
```

## IPC Pattern (Three-File Rule)

Every new IPC command requires changes to exactly three files:

1. `WebUI/electron/main.ts` — add `ipcMain.handle()` or `ipcMain.on()` handler
2. `WebUI/electron/preload.ts` — expose via `contextBridge.exposeInMainWorld()`
3. `WebUI/src/env.d.ts` — add TypeScript type definition to `electronAPI`

## Home Agent Slash Commands (Five-Place Rule)

A Home Agent slash command (e.g. `/reset`, `/imgGen`) is only fully wired up when it is
registered in **every** layer. The dispatcher recognizing the text is NOT enough — each chat
platform only forwards commands it has been told about, so a command handled by the dispatcher
but missing from a transport is silently dropped (Telegram) or rejected by the platform (Slack).

When adding/removing/renaming a command, update all of these:

1. **Dispatcher + help** — `WebUI/src/assets/js/store/homeAgent.ts`: add the `*_REGEX`, a branch in
   the message-processing loop, and an entry in `HELP_MESSAGE`. (Per-command behavior — inherently
   manual.)
2. **Channel transports** — `home-agent/channels/commands.py`: add a `HomeAgentCommand` to
   `HOME_AGENT_COMMANDS`. This single source of truth drives **both** the Telegram handlers +
   `set_my_commands` menu (`telegram.py`) and the Slack `@bolt_app.command` handlers (`slack.py`),
   so they can never diverge.
3. **Slack manifest** — `WebUI/src/components/SlackSetupSteps.vue`: add the command to
   `slash_commands` in `MANIFEST_JSON`. Slack only delivers slash commands declared in the
   app manifest the user installs, so this must match `commands.py`. (Separate process/language —
   manual.)
4. **LAN chat command menu** — `home-agent/channels/local_web_app_html.py`: add an entry to the
   `COMMANDS` array in the served page's JS. That menu is the only command discovery the browser
   has (it never sees `commands.py`), so an omission means the command exists but nobody can find
   it, and a stale entry offers one that no longer works.

Slack commands must be lowercase; use `queued`/`telegram_aliases` in `commands.py` for camelCase
spellings (e.g. `/imgGen`). LAN chat reaches the dispatcher through its own served page rather than
through `commands.py`, so a command working there does NOT prove it works on Telegram/Slack.

## i18n / Translations (English is the Source of Truth)

Locale files live in `WebUI/src/assets/i18n/` (`en-US.json` + 12 others: `de`, `es`, `id`, `it`,
`ja`, `ko`, `pl`, `th`, `tr`, `vi`, `zh-CN`, `zh-TW`). **`en-US.json` is the single source of
truth.** The loader (`store/i18n.ts`) merges `en-US` as a fallback under the active locale, so a
missing key renders in English rather than crashing — but a missing/stale key is still a bug to fix,
not a feature.

**Whenever you add, change, or remove a key in `en-US.json`, apply the same change to all 12 other
locale files in the same commit:**

- **Added key** → add it to every locale with a translation of the new English value.
- **Changed English value** → re-generate (re-translate) that key in every locale so translations
  don't drift from the current English wording.
- **Removed key** → remove it from every locale (no orphan/extra keys).

Rules for the locale files:

- Every locale must have the **exact same key set** as `en-US.json` — no missing, no extra keys.
- Preserve `{placeholder}` tokens verbatim (e.g. `{tool}`, `{error}`) — same set per key as English.
- Do **not** translate product/technical names: `AI Playground`, `ComfyUI`, `HuggingFace`, `MCP`,
  `GPU`, `vRAM`, `OpenVINO`, `INT4`, `KV Cache`, model ids; keep mode names `Chat`/`Image Gen`/`Image Edit`.
- Match file format: UTF-8 (raw non-ASCII, not `\u` escaped), 2-space indent, trailing newline.

To keep this mechanical, a parity check is a plain script: load `en-US.json` and each locale, diff
the key sets, and diff the `{...}` placeholder set per key. Add English keys first, then translate.

## CI Checks

- **ESLint + Prettier**: runs on every push/PR (`eslint-prettier.yml`)
- **Ruff**: Python linting on `service/` directory (`ruff.yml`)
- **Bandit**: Python security scanning (`bandit.yml`)
- **Trivy**: Vulnerability scanning (`trivy.yml`)

---

## Architecture Quick Reference

This section eliminates the need for codebase exploration at the start of each session.

### Navigation (No Vue Router)

There is **no Vue Router**. Navigation is state-driven:

- `App.vue` checks `globalSetup.loadingState` (`verifyBackend` → `manageInstallations` → `loading` → `running`/`failed`)
- Once running, `promptStore.currentMode` controls which view renders: `chat`/`audio` → `Chat.vue`, `agent` → `AgentMode.vue`, `imageGen`/`imageEdit`/`video` → `WorkflowResult.vue`
- Each mode maps to a preset category (`chat`, `audio`, `create-images`, `edit-images`, `create-videos`). `chat`, `agent` and `audio` all run on `chat`-type presets; `audio` holds the speech presets (Text to Speech / Speech to Text) and gets its own settings panel (`SettingsAudio.vue`)
- `PromptArea.vue` is the shared prompt input bar across all modes
- **The preset picks the mode**, via `presetToMode()` in `src/lib/presetModes.ts`. A chat preset
  with `agentPreset: true` (Agent, Game Agent) renders Agent Mode, so there is no Agent mode
  button — it is entered by picking one of those presets from the chat list.

### Backend Services (4 services, dynamic ports)

Managed by `electron/subprocesses/apiServiceRegistry.ts`. Each service spawns a child process and exposes an OpenAI-compatible HTTP API:

| Service            | Ports       | Binary/Entry                        | Health Endpoint    | Purpose                                                          |
| ------------------ | ----------- | ----------------------------------- | ------------------ | ---------------------------------------------------------------- |
| `ai-backend`       | 59000-59999 | `service/web_api.py` (Python Flask) | `/healthy`         | Model downloading/management only — **NOT inference**            |
| `llamacpp-backend` | 39000-39999 | `llama-server` (native)             | `/health`          | GGUF model inference (LLM + embedding sub-servers)               |
| `openvino-backend` | 29000-29999 | `ovms` (native)                     | `/v2/health/ready` | OpenVINO inference (LLM + embedding + transcription sub-servers) |
| `comfyui-backend`  | 49000-49999 | ComfyUI `main.py` (Python)          | `/queue`           | Image/video/3D generation via workflows                          |

### Three Communication Patterns

1. **Electron IPC** (renderer ↔ main): ALL service lifecycle — start, stop, setup, device selection, `ensureBackendReadiness`. Renderer calls `window.electronAPI.*`, main handles via `ipcMain.handle()`. Main pushes events via `win.webContents.send()`.

2. **Direct HTTP** (renderer → backend): For actual AI operations after service is ready:
   - **Chat inference**: Vercel AI SDK `streamText()` → `{backendUrl}/v1/chat/completions` (LlamaCpp/OpenVINO)
   - **Model management**: `fetch()` → Flask ai-backend `/api/*` (download, check, size)
   - **Image generation**: `fetch()` → ComfyUI `/prompt`, `/upload/image`, `/interrupt`, `/free`

3. **Utility process** (main ↔ langchain worker): `electron/subprocesses/langchain.ts` for RAG document processing via `process.parentPort` messaging.

### Chat Inference Flow

User sends message → `textInference.ensureReadyForInference()` → IPC `ensureBackendReadiness` (loads model on-demand) → `openAiCompatibleChat` uses Vercel AI SDK `streamText()` → direct HTTP to backend's `/v1/chat/completions` → streamed response.

### Model catalog (`WebUI/external/models.json`)

Parsed in the main process with `ModelSchema` (`WebUI/src/types/shared.ts`) — **Zod strips unknown
keys**, so a new field is invisible until it is added to the schema, then copied through
`models.ts` (`refreshModels`) and `textInference.ts` (`llmModels`), both of which build their
objects field by field.

An entry may declare `inferenceDefaults`: the sampling its publisher recommends. Top-level keys are
the shared base; `thinking` / `instruct` override them per mode (hybrid-thinking models want
different numbers), and `reasoningEffort` names the default depth for templates that read
`chat_template_kwargs.reasoning_effort` (Qwen3.8). `src/lib/samplingDefaults.ts` resolves the
profile against the live thinking state and maps it to wire names — llama.cpp's `repeat_penalty` +
`min_p` vs OVMS's `repetition_penalty`.

How the values reach a turn:

- **temperature / reasoning effort** become the _defaults_ of the user-facing settings. A preset
  that declares its own `temperature` wins, and so does anything the user changed: `textInference`
  records the value it applied (`temperatureFromModel`, per preset) and only replaces a setting
  that still equals it, so a model switch or a flip of the thinking toggle re-picks the profile
  while a deliberate choice survives.
- **everything else** (`top_p`, `top_k`, `min_p`, penalties) has no UI and rides on the request:
  `chatModel.ts`'s `transformRequestBody` for chat, `samplingParams` on the resolved Pi model
  (`piAgentManager.ts`) for agent turns. Cloud providers get none of it — they reject parameters
  they do not model. OVMS ignores what it does not know (verified: `min_p` / `repeat_penalty`
  still return 200), so the dialect mapping is about correctness, not avoiding rejections.

**Reasoning effort is set for the expensive case, which is the agent.** A chat reply pays for
thinking once; an agent turn pays per step, and a Game Agent run is dozens of steps. Qwen3.8-27B at
`medium` spent 15 minutes producing three file reads, so both its `models.json` entries recommend
`low`. There is no per-preset override — the level travels with the model, in
`chat_template_kwargs.reasoning_effort` (`chatModel.ts` for chat, `buildSamplingParams` in
`store/agentMode.ts` for agent turns), and the Chat settings dropdown remains the way to raise it.

**A model can ask for its own `llama-server` flags.** `models.json` `llamaCppArgs` is a parameter
string in the same syntax as the backend-settings box; it rides `ensureBackendReadiness` beside
`contextSize` (renderer → preload → main → service), is sanitized like the user's — the catalog is
refreshed from a remote repo — and is spliced in _ahead_ of the user's parameters by
`buildLlmServerArgs`, so a hand-written flag still wins and `--host 127.0.0.1` still comes last. A
change to the string relaunches the server, since flags are baked into the command line. Only
llama.cpp reads it; OVMS has a different command line and is passed nothing. The Qwen3.8-27B entries
use it for `--spec-type draft-mtp`: the GGUFs carry MTP layers that llama-server otherwise loads and
discards (`unused tensor blk.64.nextn.*`), and drafting off them roughly doubles decode on Arc B390
(5.6 → 11.5 tok/s writing a game, 5.6 → 10.2 tok/s editing one) at ~86% draft acceptance for ~3 GB,
with no second model to download. Generation speed, not reasoning depth, was the bulk of that
15-minute run.

**No n-grams on top of MTP.** The flag was `--spec-default --spec-type draft-mtp` until a sweep of
every llama.cpp drafter showed `--spec-default` is what enables the n-gram layer, and that the layer
only costs: on edit-heavy Game Agent turns — the case n-grams are supposed to win, since every
`edit` quotes its context verbatim — it drafted 505 more tokens than MTP alone and had 27 _fewer_
accepted, because at ~87% acceptance MTP has already taken the headroom. `ngram-simple` and
`ngram-map-k4v` are worse still: both are slower than no speculation at all and both change the
model's output at `temperature 0`. Timings on that box swing ±30% between identical runs, so
configurations were compared on deterministic draft counters, not on stopwatch medians.

**Thinking is capped for Qwen3.8, and only for Qwen3.8.** `reasoning_effort: low` did not stop it
drafting: a Game Agent run spent 20 minutes and ~6k tokens writing the whole asteroids game inside
one thinking block, then hit its turn limit before the first `edit`. Reasoning tokens cost what
output tokens cost and cannot be play-tested, so that draft was paid for and largely thrown away
(see `--reasoning-preserve` below for the part that was recoverable).
`--reasoning-budget 2048` (with a `--reasoning-budget-message`
that tells the model to act on what it has) is a hard stop the prompt cannot argue with. It is a
server flag, not a request field — `reasoning_budget` in the body is ignored, verified against
b10430 — which is why it lives in `llamaCppArgs`: per model, so a cap aimed at one slow local model
never reaches anyone's chat with another. The message is a quoted sentence, which is why
`splitParameterString` parses the parameter string like a shell instead of splitting on whitespace.
Confirmed against the running server: a game-planning turn stopped at ~2.2k reasoning tokens
mid-word and carried the message into the trace, then went on to answer.

**`--reasoning-preserve` is a no-op here — do not add it back.** Pi puts every stored thinking block
back on its assistant messages as `reasoning_content` (`pi-ai`'s `openai-completions` request
builder — not gated on the model's `reasoning` flag, which we register as `false`), so the whole
trace is on the wire each step, and what happens next is decided by the template, not by us.
Qwen3.8's gate reads
`preserve_thinking is undefined or preserve_thinking is true or loop.index0 > ns.last_query_index`:
undefined already preserves, and the trailing clause keeps everything after the last user message
regardless — which inside an agent turn is the entire tool loop. Rendering a two-turn history
through `/apply-template` confirms it: no kwargs and `preserve_thinking: true` are byte-identical
(all traces kept), and only an explicit `false` drops anything, and then only the _earlier user
turn's_ traces. llama.cpp's flag default is "template default", i.e. the variable is left unset, so
starting the server with `--reasoning-preserve` changes nothing that was not already true.

The measurement that made this worth chasing still stands as a warning about prompt-prefix
stability: on Arc B390 the 27B prefills at ~130 tok/s, so a 24k-token agent prompt costs ~3 minutes
to process from scratch. Against the live server, replaying an agent step with the earlier traces
kept reused 4321 of 5740 prompt tokens (13.7s), while the same step with those traces stripped —
half the size — reused 54 and had to process 2356 (15.7s): a _smaller_ prompt that took _longer_,
because the deletion moved the divergence point to the front. Anything that rewrites history
mid-prompt (dropping reasoning, re-summarizing, renumbering tool ids) forfeits the whole KV cache
every step, which is far more expensive than the tokens it saves.

**Agent turns get their sampling from an extension, not from the model.** `Model.samplingParams` is
a pi-ai field, and pi-coding-agent never reads it (the identifier does not occur in the package), so
for a long time a local agent turn silently sent none of it: no recommended sampling, no
temperature, no `chat_template_kwargs` — the thinking toggle looked wired up and changed nothing,
while the same settings worked in Chat. `electron/agentMode/piSampling.ts` registers a
`before_provider_request` extension (Pi's supported per-request seam; the handler's return value
replaces the body) that merges the bag into every request. The bag is read through a callback, so a
change between two steps of one turn reaches the very next request. `electron/test/agents/agentSampling.test.ts`
pins this against a fake OpenAI server driving a real Pi session — assert on the recorded request
bodies, because nothing else proves Pi forwarded anything.

**A local agent session must not remember its endpoint.** llama.cpp's LLM server is relaunched
whenever a media call hands the GPU to ComfyUI and takes it back — which happens _mid-turn_ — and
`get-port` will not return a port it handed out in the last 15 seconds, so it used to come back on a
different one every time (39100 ⇄ 39101). pi-ai stamps a provider's base URL onto each model it
builds and reads it off that object per request, so a session kept calling the port it was born
with: every step after the first image generation failed the instant it was made — no tokens, no
error text, `gen_ai.response.finish_reasons: ["error"]`, retried 2 s / 4 s / 8 s apart, then the run
gave up. It reads like a broken model and is only visible in a trace.
`electron/agentMode/piLocalEndpoint.ts` therefore resolves the endpoint per request off the live
service (`llmServerBaseUrl` in `llmServerSnapshot.ts`) and hands Pi a model whose `baseUrl` is an
accessor — the same re-rooting the renderer's chat model does, which is why Chat never had the
problem. Consequences worth knowing: the session key ignores the URL (a moved port is not a
different model and must not rebuild a live session), the timing observer asks per request too
(`piCallTiming.ts`, or steps after a relaunch lose their speeds), and
`llamaCppBackendService.allocateLlmPort` takes the previous port back when it is free, so the URL
usually does not move at all. OVMS is unaffected either way — its LLM server runs on the service's
own port, allocated once. `electron/test/agents/agentEndpoint.test.ts` moves the backend between two
steps of a real Pi session and asserts which fake server received the second one.

**"Reasoning only during planning" (Agent Mode).** Thinking earns its cost while the agent decides
what to build and stops earning it once that decision is on disk, so a Game Agent session can
switch thinking off for the rest of the run. What counts as "on disk" is the capability's to say
(`AgentCapability.planningEnd`): `plan-file` for `game-studio`, which then works down the checklist
in `design.md`, and `first-write` for `game-studio-quick`, whose first write is the finished game.
`electron/agentMode/planningPhase.ts` owns the switch (spotting that write in
`tool_execution_start/end`, and a plan already on disk at session start); the settings toggle is
`agentMode.planningThinkingOnly`, persisted on the Agent Mode store (copied once from chat
`settingsPerPreset` on upgrade) and passed as `AgentModeTurnConfig.planningThinkingOnly`. It only
bites where the model has a thinking switch,
thinking is on, and the capability declares an end — a cloud turn or a template without
`enable_thinking` is unaffected.

**A one-turn session has to be split before that switch means anything.** Quick Coder's first
traces showed the model doing everything in one reply — reasoning, then the whole game — so
`first-write` flipped thinking off with nothing left to spend it on. A capability can therefore
declare `AgentCapability.planHandoff`, which cuts the first turn in two: the model is asked for the
plan alone (its prompt says so, and stops there), and `handOffToBuild` in `piTurnRunner.ts` then
sends the handoff text itself — the approval, granted programmatically — as a second
`session.prompt()` inside the same turn, after thinking has gone off. The renderer sees one turn
throughout, the way it already does for the silent-turn nudge. Two guards matter: a plan step that
_built_ anyway gets no handoff (the watcher reports whether any writing tool ran, so the file is not
written twice), and only a session that starts empty plans — a resumed one reopens on a finished
game, where the next request is a change, not a plan. The split is the capability's shape and
happens whether or not the user asked for planning-only thinking; the setting decides only whether
the build request drops thinking.

**Context size is not honored everywhere.** OVMS on NPU compiles a static graph for
`--max_prompt_len`, so the preset's `contextSize` is capped by `npuPromptLen()`
(`src/types/shared.ts`) before the server is started — agent presets ask for 128k, which the NPU
cannot pay for up front. `effectiveContextWindow` applies the same cap so the context gauge shows
what the turn actually gets. OpenVINO on GPU ignores `contextSize` entirely (dynamic KV cache).

**Pi's compaction defaults assume a 64k+ window.** Auto-compact fires when occupancy exceeds
`contextWindow − reserveTokens`, then keeps `keepRecentTokens` of the tail (Pi defaults 16384 /
20000). On 32k those cannot fit: keep already exceeds the 16k trigger, so a compact lands at ~20k
and the next llama.cpp request still overflows `n_ctx`. We pass window-scaled settings
(`electron/agentMode/piCompaction.ts`: reserve ≤ ¼ window capped at 16k, keep ≤ ⅓ capped at 20k,
`keep + reserve` under the window) into `SettingsManager.inMemory()`, and `outputTokenBudget` is
capped so the post-compact tail plus generation still fits. A 32k session that did not auto-compact,
or compacted a split Game Agent turn to "No prior history.", is this mismatch — not dropped context.

### Error & generation state architecture

Errors and long-running operations converge on a few shared primitives instead of being handled
ad hoc per call site. **Full reference: [`docs/error-state-activity-architecture.md`](docs/error-state-activity-architecture.md)**
(error model + sink, app boot FSM, generation FSM, and the activity/progress sink, with a chat-turn
diagram and conventions for adding new state). The summary below is the quick version.

**Error model + sink:**

- `assets/js/errors/types.ts` — `AppError` type (`code`, `category`, `severity`, `surface`,
  `userMessage`, `technicalMessage`, `context`, `recoverable`, `action`, `cause`, `timestamp`).
  Branded with a plain `__isAppError: true` literal so it survives serialization.
- `assets/js/errors/appError.ts` — `createAppError()`, `isAppError()`, `normalizeError()` (coerces
  any caught value into an `AppError`), plus serialize/deserialize helpers.
- `store/errors.ts` (`useErrors`) — the only place errors are surfaced. `report()` normalizes, logs,
  de-duplicates (by `AppError` instance, via a `WeakSet`), and surfaces per `surface`.
- `main.ts` wires global capture (Vue `errorHandler`, `unhandledrejection`, `window.error`) into the
  sink, so nothing falls through silently. Chat (`openAiCompatibleChat`), preset switching, and boot
  all route through it.

**App boot state machine:** `globalSetup.loadingState` (`verifyBackend → manageInstallations →
loading → running | failed`). `setupWizard.initialize()` wraps init in try/catch; on failure it sets
`loadingState = 'failed'` + `globalSetup.errorMessage` (the previously-dead `failed` screen is now
reached) and reports to the sink with `surface: 'silent'` (the screen already shows the message).

**Generation lifecycle (`imageGenerationPresets` + `comfyUiPresets`):** image/video/3D generation is
modeled as an explicit FSM rather than loose flags.

- `GenerateState` (`store/imageGenerationPresets.ts`) drives the UI overlay: `start_backend` →
  `install_workflow_components` → `load_workflow_components` → `generating` → `image_out`, plus
  `no_start`/`error`. The `start_backend` state shows a "Starting image backend" bar so the
  backend-boot / queued-retry window is never silent.
- `MediaItem.state` has terminal states: `done`, `failed`, `stopped` (no more permanent spinners).
  `failGeneration(msg)` / `cancelGeneration()` settle all in-flight items and set `lastError`;
  `WorkflowResult.vue` / `ChatWorkflowResult.vue` render a `failed` panel from `lastError`.
- **Watchdog**: `comfyUiPresets` arms a timer on `execution_start` and clears it on
  success/error/interrupt; a stall reports `generation/timeout` and fails in-flight items.
- **Crash detection**: a watch on the ComfyUI service status fails in-flight items if the backend
  leaves `running` unexpectedly (guarded by `backendRestarting` so intentional restarts for custom-node
  installs don't false-positive). The main-process `service.ts` also reports unexpected child exits.
- **Tool watchers** (`tools/comfyUi.ts`, `tools/comfyUiImageEdit.ts`) resolve on terminal item states
  (`failed`/`stopped`) and on watchdog timeout, returning an error result to the LLM instead of hanging.

**Activity / progress sink (`store/activities.ts`):** the analog of the error sink for "what is the
app busy with right now". Long-running steps report a typed `Activity`
(`assets/js/activities/types.ts`: `category`, `label`, `progress?`, `scope`, `parentId?`, `state`).
Producers: backend/model prep + RAG (`textInference`), MCP/tool resolution + image conversion +
"Processing prompt…"/"Processing results…" inference waits (`openAiCompatibleChat`), MCP/ComfyUI tool execution (`tools/*`), and the
generation FSM bridge (`comfyUiPresets`, with determinate progress from the WS). Consumers:
`ChatActivityIndicator.vue` (anchored to the in-progress chat turn; replaced the old
`isPreparingBackend` bar) and `PromptArea.vue` busy state. `begin/update/end/track` manage lifecycle;
`track()` guarantees cleanup; `chatActivity(key, exclude?)` returns the innermost active (or nested,
via `parentId`) activity for a conversation; `endScope()` is the anti-stuck reconciliation. The store
has no store deps (avoids cycles); reconciliation lives in the producing stores.

### Key IPC Channels by Category

**Service lifecycle**: `getServices`, `startService`, `stopService`, `setUpService`, `serviceSetUpProgress` (M→R), `serviceInfoUpdate` (M→R), `uninstall`, `updateServiceSettings`, `detectDevices`, `selectDevice`, `ensureBackendReadiness`

**Models**: `loadModels`, `updateModelPaths`, `restorePathsSettings`, `getDownloadedGGUFLLMs`, `getDownloadedOpenVINOLLMModels`, `getDownloadedEmbeddingModels`

**Settings/config**: `getInitSetting`, `updateLocalSettings`, `getLocaleSettings`, `getInitialPage`, `getDemoModeSettings`

**Presets**: `reloadPresets`, `loadUserPresets`, `saveUserPreset`, `updatePresetsFromIntelRepo`, `getUserPresetsPath`

**RAG**: `addDocumentToRAGList`, `embedInputUsingRag`, `getEmbeddingServerUrl`

**ComfyUI tools**: `comfyui:isGitInstalled`, `comfyui:isComfyUIInstalled`, `comfyui:downloadCustomNode`, `comfyui:uninstallCustomNode`, `comfyui:installPypiPackage`, `comfyui:isPackageInstalled`, `comfyui:listInstalledCustomNodes`

**Transcription**: `startTranscriptionServer`, `stopTranscriptionServer`, `getTranscriptionServerUrl`

**Dialogs/files**: `showOpenDialog`, `showSaveDialog`, `showMessageBox`, `existsPath`, `saveImage`

**Window**: `getWinSize`, `setWinSize`, `miniWindow`, `setFullScreen`, `exitApp`, `zoomIn`, `zoomOut`

### Pinia Stores — What Each Does

**Domain stores** (core business logic):

- `textInference` — LLM backend/model selection, RAG config, system prompt, context size, per-preset settings. Deps: `backendServices`, `models`, `dialogs`, `presets`
- `openAiCompatibleChat` — Vercel AI SDK chat instances, message streaming, tool calling, vision, token tracking. Deps: `textInference`, `conversations`
- `imageGenerationPresets` — Image/video generation state (prompt, seed, dimensions, batch), ComfyUI dynamic inputs. Deps: `presets`, `comfyUiPresets`, `backendServices`, `ui`, `dialogs`, `i18n`
- `comfyUiPresets` — ComfyUI WebSocket + REST communication, workflow execution, custom node management. Deps: `imageGenerationPresets`, `i18n`, `backendServices`, `promptArea`
- `models` — Model discovery, download checking, HuggingFace integration, path management. Deps: `backendServices`
- `presets` — Unified preset system with Zod schemas (`chat` + `comfy` types), variants, file I/O. Deps: `backendServices`
- `conversations` — Conversation CRUD and persistence. No store deps.

**Orchestration stores:**

- `backendServices` — Service lifecycle, device selection, version management. No store deps. Heavy IPC usage.
- `presetSwitching` — Unified `switchPreset()`, `switchVariant()` across modes. Deps: `presets`, `promptArea`, `backendServices`, `dialogs`, `globalSetup`, `i18n` + lazy `textInference`, `imageGenerationPresets`
- `globalSetup` — App initialization, loading state machine. Deps: `models`
- `promptArea` — Current UI mode (`chat`/`audio`/`imageGen`/`imageEdit`/`video`), prompt submit/cancel callbacks. Deps: `presetSwitching`, `presets`

**Infrastructure stores** (UI state, no business logic):

- `errors` — **Central error sink.** `report(err, overrides?)` normalizes any value into an `AppError`, logs it, de-duplicates (by instance), and surfaces it per its `surface` policy (toast/inline/modal/silent). Keeps `recentErrors`. No deps. See "Error & generation state architecture" below.
- `activities` — **Central activity/progress sink.** `begin/update/end/track` long-running steps; `chatActivity(key, exclude?)` / `imageGenActivity` expose the most-specific active work; `endScope()` reconciles stragglers. Single source of truth for "what is the app busy with" (backend prep, RAG, tools, thinking, generation). No deps. See "Error & generation state architecture" below.
- `dialogs` — Dialog visibility state (download, warning, requirements, installation progress, mask editor). No deps.
- `ui` — History panel visibility. No deps.
- `theme` — Theme selection, persisted in the renderer (the four themes are a constant in the store). No deps.
- `i18n` — Locale/translations. IPC: `getLocaleSettings`. No deps.
- `demoMode` — Demo mode overlay + auto-reset timer. IPC: `getDemoModeSettings`. No deps.
- `speechToText` — STT enabled state, initialization. Deps: `backendServices`, `models`, `dialogs`, `globalSetup`
- `audioRecorder` — Browser MediaRecorder, transcription via AI SDK. Deps: `backendServices` (lazy)
- `developerSettings` — Renderer-persisted developer toggles: dev console on startup, keep models loaded, dummy media workflows, verbose agent logging. No deps.
- `debugSettings` — The settings.json-backed half of Settings → Developer (see below). No deps.

### Settings, feature gates and developer controls

There are three places a switch can live, and which one it is decides who can flip it.

**`settings.json` (`LocalSettingsSchema` in `electron/main.ts`)** is machine-level: hand-edited,
read by the main process, survives a renderer storage wipe. It keeps the things a deployment
decides — demo mode + passcode, `languageOverride`, `productMode`, `disabledBackends`, device
preferences, `huggingfaceEndpoint` — plus **`showDebugSettingsInUI`**, which is the only gate on
the debug controls below. A build that does not set it looks exactly as it always did.

**Renderer persistence (Pinia)** is per-user and needs no file: theme selection, Cloud Mode
enablement, everything in `developerSettings`.

**Settings → Developer** is the UI. Always visible: keep models loaded, dev console on startup,
and the **Agent preset** checkbox (writes `isAgentPresetEnabled`, then re-reads presets — no
restart). Behind `showDebugSettingsInUI`: verbose agent logging, dummy media workflows, pretend
Phison SSD, OEM vendor override, remote repository, OpenVINO image-gen devices — and the same
flag shows the title-bar setup-wizard shortcut and unlocks the dev-only test LLM + dummy
workflows, so a packaged build can use them.

Two things are deliberately not flags any more. DevTools follows `openDevConsoleOnStartup`
alone, whose default is "on when unpackaged" — main falls back to `!app.isPackaged` when the
renderer has stored nothing. And verbose agent logging is a setting rather than the `AGENT_DEBUG`
env var, which stays only as a one-shot override for a launch with no UI yet.

### Feature → File Map

**Chat/LLM**: `views/Chat.vue` → stores: `openAiCompatibleChat`, `textInference`, `conversations`, `presets` → electron: `ensureBackendReadiness` IPC → backend: `llamacpp`/`openvino` via Vercel AI SDK

**Image/Video Generation**: `views/WorkflowResult.vue` → stores: `imageGenerationPresets`, `comfyUiPresets`, `presets` → electron: service lifecycle IPC → backend: `comfyui-backend` via direct HTTP

**Model Management**: stores: `models` → electron: `loadModels`, `getDownloaded*` IPC → backend: `ai-backend` Flask `/api/*` via HTTP

**Settings**: `components/settings/SideModalAppSettings.vue`, `components/settings/SideModalSpecificSettings.vue` → stores: `backendServices`, `textInference`, `imageGenerationPresets`, `theme`, `i18n`

**Presets**: `components/PresetSelector.vue`, `components/VariantSelector.vue` → stores: `presets`, `presetSwitching`

**Service Management**: `components/InstallationManagement.vue` → store: `backendServices` → electron: `apiServiceRegistry.ts`, `electron/subprocesses/*.ts`

### Electron Main Process Files

| File                                              | Purpose                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `electron/main.ts`                                | Window creation, all IPC handlers (~68 channels), app lifecycle                  |
| `electron/preload.ts`                             | `contextBridge` exposing `electronAPI` to renderer                               |
| `electron/pathsManager.ts`                        | Singleton managing all app/model/service filesystem paths                        |
| `electron/remoteUpdates.ts`                       | Fetching model lists and preset updates from GitHub                              |
| `electron/subprocesses/apiServiceRegistry.ts`     | Service registration, port allocation, lifecycle orchestration                   |
| `electron/subprocesses/service.ts`                | Base classes: `GenericService`, `ExecutableService`, `LongLivedPythonApiService` |
| `electron/subprocesses/aiBackendService.ts`       | Python Flask model-management backend                                            |
| `electron/subprocesses/llamaCppBackendService.ts` | LlamaCPP native server (LLM + embedding sub-servers)                             |
| `electron/subprocesses/openVINOBackendService.ts` | OpenVINO OVMS (LLM + embedding + transcription sub-servers)                      |
| `electron/subprocesses/comfyUIBackendService.ts`  | ComfyUI Python server                                                            |
| `electron/subprocesses/langchain.ts`              | RAG utility process (document splitting, embedding, vector search)               |
| `electron/subprocesses/deviceDetection.ts`        | Intel GPU device detection and env var setup                                     |
| `electron/logging/logger.ts`                      | Logging, sends `debugLog` events to renderer                                     |

## Cursor Cloud specific instructions

### Running the dev server

```bash
cd /workspace/WebUI
npm run fetch-external-resources   # required on Linux if `build/resources/uv.exe` is missing
DISPLAY=:1 npm run dev
```

The Vite dev server starts on `http://localhost:25413` and Electron opens automatically.
A virtual framebuffer (`Xvfb`) is already running on `:1`.

**Linux prerequisite (don’t skip):**

- If you see errors like `UV executable not found`, run `npm run fetch-external-resources` from `WebUI/`.
- This downloads platform binaries into `build/resources/` (notably `uv.exe` and `7zr.exe`) which are required
  for the `ai-backend` setup during `npm run dev`.

### Backend services on Linux

The `ai-backend`, `llamacpp-backend`, `comfyui-backend`, and `openvino-backend`
services run on Linux (Ubuntu x64). The packaged installer/AppImage supports
Ubuntu 24 or newer only:

- Run `npm run fetch-external-resources` once to download `uv` and `7zip` binaries for
  the current platform (placed in `build/resources/`).
- Start the Electron app with `DISPLAY=:1 npm run dev`. On the setup dialog, click
  **Install** next to the backends you need.
- `ai-backend` runs a Python Flask server on port 59000 (health: `GET /healthy`).
- `llamacpp-backend` downloads the `ubuntu-vulkan-x64` (GPU) build when a Vulkan
  loader is present, otherwise the `ubuntu-x64` CPU build (health: `GET /health`).
- `comfyui-backend` uses the `xpu` (torch+xpu) variant when the Intel Level Zero
  runtime is present, otherwise `cpu`.
- `openvino-backend` runs OVMS against the **system** Python on Linux and detects
  Intel `GPU`/`NPU` devices via its Python detection venv.

**Intel GPU on Linux** (Arc / iGPU): install host GPU drivers **before** AI
Playground (Intel OMIX guide for compute/kernel; Vulkan for llama.cpp). See
[`docs/linux-intel-gpu-setup.md`](docs/linux-intel-gpu-setup.md).

### Testing inference end-to-end

A small test model (`LFM2.5-350M-Q4_K_M.gguf`, ~255 MB) is available in dev mode.
It is injected by the models store (`WebUI/src/assets/js/store/models.ts`) when
`debugToolsEnabled` is true (i.e., when running via `npm run dev`) or when settings.json
sets `showDebugSettingsInUI` — which is how it reaches a packaged build. It is not listed
in `models.json`. To test inference:

1. Start the app via `npm run dev`, install both backends via the setup dialog, then click **Continue**.
2. Open **Chat Settings**, select **LFM2.5-350M-Q4_K_M.gguf** from the Model dropdown.
3. Type a message and send — the app auto-downloads the model from HuggingFace on first use.
4. The llamacpp-backend will load the model and serve streaming responses.

**Network requirement**: Model downloads redirect through `cas-bridge.xethub.hf.co`
(HuggingFace Xet CDN). This domain must be in the egress allowlist. Allowlist changes
only take effect on new VM sessions — a running VM will not pick up changes.

### Home Agent channels (`telegram`, `slack`, `local-web`, dev-only `mock`)

Each channel is one renderer `ChannelAdapter` (`src/assets/js/store/channels/`) plus one Python
module (`home-agent/channels/`), wired together by `ChannelKind` in both languages and dispatched
through the generic `/channel/<kind>/*` Flask routes — adding a platform touches no shared logic.

Outbound actions are named after the adapter methods, so they cross the language boundary in
camelCase and are mapped to `send_*` methods by `channels/actions.py`. That list is the allow-list
the route dispatches against, and it must stay in sync with the action union in `adapter.ts` /
`preload.ts` / `env.d.ts`. A channel may omit a method it has no use for (only the LAN page needs
`history`) and the route answers 404 for it.

`local-web` ("LAN chat") is the odd one out: instead of talking to a cloud bot API it _is_ the
server. `home-agent/channels/local_web.py` stands up a `ThreadingHTTPServer` in a daemon thread
that serves a self-contained page (`local_web_app_html.py`) to browsers on loopback — or the whole
LAN when `allowLan` is on — takes inbound messages on `POST /api/chat` behind a password login,
and pushes every `send_*` out as one Server-Sent Event. Things worth knowing before changing it:

- **The page is a product surface, not a fixture.** It ships as a raw string of HTML/CSS/JS, so it
  has no build step, no framework and no Tailwind — and no type checking or linting either. Verify
  changes by loading it in a browser; `node --check` on the extracted `<script>` catches syntax
  errors early.
- **Anything data-shaped goes through the DOM.** `formatBotText` output is the only thing allowed
  near `innerHTML`; base64 payloads, mime types and filenames are set as DOM properties by the
  `inline*` helpers, and mime types are matched against an allow-list.
- **It keeps no history**, so an event sent while no browser is connected is simply gone, and both
  `/new` and `/load` have to repaint it (`ChannelAdapter.replayHistory`, implemented only here).
- **SSE has no message edit**, so a settled interactive prompt travels as its own `editMessage`
  action and the page retires the buttons; typing carries an explicit `state: start|stop`.
- **Restarting binds a socket**, so config changes are serialized under `_start_lock` and wait for
  the previous server to close before rebinding the same port.
- **It is reachable by other people.** Login is constant-time and rate-limited per source address,
  request bodies are capped, and any response sent before its request body is read must close the
  connection or the keep-alive stream desyncs. Traffic is plain HTTP.
- The `# nosec B104` on the `0.0.0.0` bind is deliberate (that is what `allowLan` means) — Bandit
  scans the whole repo in CI, so keep the justification with it.

### Verifying media generation (dummy workflows)

Four dev-only ComfyUI presets return placeholder media in ~0.3s instead of running a real
model, so the media plumbing (tool catalogs, the media specialist agent, workflow input
substitution, `MediaItem` typing, workspace saving, UI rendering) can be smoke-tested on a
laptop. They are injected by `WebUI/src/assets/js/store/devPresets.ts` when
`debugToolsEnabled` is true or settings.json sets `showDebugSettingsInUI`, mirroring the
dev-only test LLM in `models.ts`, and they use only core ComfyUI nodes — no models, no
custom nodes, no downloads.

| Preset                  | Mode / tool category        | Output              | Graph                                      |
| ----------------------- | --------------------------- | ------------------- | ------------------------------------------ |
| `Dummy Image (test)`    | Image Gen / `create-images` | solid-colour PNG    | `EmptyImage` → `SaveImage`                 |
| `Dummy Edit (test)`     | Image Edit / `edit-images`  | colour-inverted PNG | `LoadImage` → `ImageInvert` → `SaveImage`  |
| `Dummy Video (test)`    | Video / `create-videos`     | solid-colour mp4    | `EmptyImage` → `CreateVideo` → `SaveVideo` |
| `Dummy 3D Model (test)` | Image Edit / `edit-images`  | placeholder `.glb`  | `Load3D` → `SaveGLB`                       |

Notes:

- Prompts are ignored (like the real `Colorize` / `Image To 3D Model` no-prompt presets), so
  `modifySettingInWorkflow` logs a harmless "No key found for setting prompt" warning. Width,
  height and batch size are wired for real; the edit dummy inverts colours so a visible change
  proves the source image actually reached ComfyUI.
- `Dummy 3D Model (test)` needs two fixture files in ComfyUI's input dir (a ~700-byte pyramid
  `.glb` and a tiny preview PNG). They are generated in TypeScript and uploaded via
  `/upload/image` by `ensureDummyWorkflowFixtures()`, called from `comfyUiPresets.generate()`
  once per session. Its `Load Image` node is deliberately unconsumed: it keeps the
  "needs a source image" contract (and exercises the upload path) without being executed.
- `toolInstructions` tell the model these are test-only workflows, so ask for them explicitly
  ("using only the dummy test workflows, …"). Delegation puts them behind the single `media`
  tool, so one request can chain image → 3D.

### Verifying the Game Agent preset (game library)

`Game Agent` is a chat preset that runs on the agent harness (`agentPreset: true`) with the
`media`, `web-debug` and `game-studio` capabilities. Its workspace is app-managed
(`agentWorkspace: 'games'`): the first turn mints `<games>/<slug>/` — `~/Documents/AI-Playground/games`
on Windows, `~/AI-Playground/games` elsewhere — and every game folder holds its own
`game.json` (`WebUI/electron/gameLibrary.ts`; no central index, `listGames()` scans for cards).

- **A new game folder is not empty.** `createGame()` writes a scaffold
  (`WebUI/electron/gameScaffold.ts`): `index.html` (canvas + a _classic_ `<script src="game.js">`)
  and `game.js` — a running dt-based loop, keyboard + pointer input and a `window.__game` hook,
  divided by `// === section ===` markers so `edit` has unique targets. The split is only safe
  because Play opens the entry as a `file://` page, where ES modules and `fetch()` of a sibling
  file are blocked; `type="module"` would work in the agent's HTTP preview and break on Play.
  The point is that the first agent action is an `edit`, not a whole-game `write` that overruns
  the completion cap.
- **Play-testing is text, not vision.** The workspace preview server injects
  `/__aipg-probe.js` into every HTML response (`agentMode/previewProbe.ts`, served ahead of the
  containment check so no workspace file can shadow it; HTML is buffered rather than streamed so
  `Content-Length` stays right). `browser {"action":"probe"}` then reports uncaught errors, frames
  counted over 500 ms, canvas ink ratio, which input events the page listens for, what a
  synthesized keypress changes, and `window.__game` when present, ending in a verdict. The
  injected script never reaches the shipped game. This replaced screenshot-then-look, which cost
  an image decode per check and preceded every `ErrorDeviceLost` crash in the 35B benchmark runs;
  the skills now say outright not to read a screenshot back as an image.
- The agent fills the library card itself with the `game` tool (`set_metadata`, `set_icon`),
  following the `html-game-studio` skill (which asks for `set_metadata` _first_ — all three 35B
  benchmark runs ran out of turns before naming their game); **Add to Arcade** in the game bar
  flips `published` and regenerates `games/index.html` + `games/library.json`. The gallery inlines
  its manifest
  because a `file://` page cannot `fetch` a sibling json.
- **Publishing is Acer-only.** The arcade page (titled "My Acer Arcade", "My Arcade" without a
  brand) is an Acer deliverable, so the add/update button and the arcade link both hang off
  `oemBranding.showsArcade`; everywhere else a game is just the files in its folder, reached with
  **Play** and the folder button. Wording comes from the store (`arcadeLabel` for the place,
  `arcadeTarget` for the action), never from a hardcoded "Acer".
- **The Acer arcade ships with four games in it**, so it is not empty on a machine nobody has built
  one on. They are bundled (`WebUI/external/arcade-samples`, an `extraResources` entry) and
  `writeArcade` copies them into the library root on every Acer arcade write
  (`electron/arcadeSamples.ts`), behind the user's own games and in `samples.json` order. Two
  things are load-bearing about where they land. They go in `_arcade-samples/` rather than
  alongside the user's games because `listGames()` reads `game.json` from the library root's
  immediate children: nested, a sample can never appear in the Game Agent session list or be
  adopted as a workspace — it is something to play, not a draft to continue. And they stay out of
  `library.json`, which is the input for uploading a library to the portal, or Intel's demos would
  be uploaded as games the user made. Each carries the `backend` / `startingModel` /
  `initialPrompt` it was really built with, which is what gives its card the info button. They are
  shipped as the agent wrote them, so `external/arcade-samples/` is prettier-ignored.
- Files the user attaches are copied into `<workspace>/attachments/` and referenced in the prompt
  as `@attachments/<file>`, which is how Pi refers to a file everywhere (its file tools strip the
  `@` when resolving). Pi's `read` hands an image back as an image part, so that one reference is
  also how an attached sprite reaches a vision model — there is no separate image channel into a
  turn. Two things have to hold for that, and both were silently missing at first: the sandbox's
  read operations must supply `detectImageMimeType` (`piToolOperations.ts`) or the bytes are
  decoded as UTF-8 into mojibake, and the model must be registered with `input: ['text','image']`
  (`modelInput` in `piAgentManager.ts`, from `textInference.modelSupportsVision`) or Pi drops the
  image and tells the model it cannot see images.
- Smoke it in seconds by asking for a trivial game and naming the `Dummy Image (test)`
  workflow for the cover, then Save → Play. A 9B model often stops after generating the
  image; one follow-up ("finish the library card") exercises the `game` tool.
- A session belongs to the preset it was held with (`AgentSessionRecord.presetName`). Game
  Agent and Quick Coder share the games library, so the Sessions panel lists both when either
  is active; resuming one still switches back to the preset it was held with. The folder-picking
  Agent keeps its own list. The panel's **+** means "new game" under a games preset
  (`agentMode.startNew()`). Sessions from before `presetName` are migrated on hydration by
  their folder.
- **Changing the agent preset by hand always starts a blank session**, in either direction and
  for every pair of agent presets. A session cannot be carried across: its capabilities are
  frozen on its record while the instructions are read live off the active preset, so a Quick
  Coder session continued under Game Agent gets Game Agent's prompt with `game-studio-quick`'s
  toolbox — told to `read` a skill with a tool it does not have — and the growing transcript
  stays filed under the preset that is no longer driving it. The watcher hangs off
  `agentPresetName` (`store/agentMode.ts`), which follows agent presets only, so the image-gen
  preset a `media` call borrows mid-turn changes nothing; it snapshots under the preset being
  left (which is why `snapshotActiveSession` takes one — a turn still running has no record yet)
  and then blanks: no folder for a games preset, the last picked folder for Agent. The old
  session stays in the panel and is reopened deliberately from there, which is the one thing
  `movingSession` suppresses the watcher for.
- **`offer_game_agent` is the only way a game moves between presets**, and it moves the folder,
  not the session (below): `startGameAgentHandoff` holds `movingSession` across its
  `switchPreset` so the game it is handing over is not blanked out from under it.
- The game bar's cover image goes through `aipg-media://games/<folder>/<icon>` — the app window
  cannot load `file://` images, so the scheme serves the game library as a second root next to
  the media folder (`aipgMediaRoots` in `electron/main.ts`).
- Pretend to be on an Acer machine with **OEM vendor override** in Settings → Developer (shown
  when settings.json sets `showDebugSettingsInUI`), then restart: the presets read "Acer Game
  Agent" / "Acer Quick Coder", the game bar gains the **Add to Arcade** and **Open My Acer
  Arcade** buttons and the gallery is Acer-branded. Setting it back to "No override" is how to
  check the non-Acer experience. It writes `oemVendorOverride`, which can equally be hand-edited
  in `{userData}/ai-playground-local-settings.json` (dev) or the per-user `settings.json`
  (packaged). Detection itself (`electron/subprocesses/oemDetection.ts`) is Windows-only, so
  without the override every machine is `unknown`.
- **`Quick Coder` is the same library, one step long.** Its only capability is
  `game-studio-quick`, which _owns the session_ (`AgentCapability.ownSession`): the preset's
  instructions replace Pi's coding-agent prompt, the workspace orientation and the skills index,
  and the builtin toolbox is cut to `write` — plus the shared `game` card tool. Its folder is
  minted with `createGame({ scaffold: false })`, so the agent writes `index.html` whole instead of
  editing a scaffold. Its turn runs in two steps — plan, then an automatic handoff that asks for the
  build with thinking off (`planHandoff`, above). A capability with `ownSession` is kept out
  of the Agent Settings checkbox list (`listCapabilities`): ticked next to another preset's agent it
  would take that agent's prompt and tools away. Use it to check the low-context path; iterative
  Game Agent is unchanged and remains the one with art and play-testing.
- **A one-shot game is handed to Game Agent, and that is the only way to revise it.** With
  `write` as its only file tool Quick Coder cannot read back what it wrote, so a bug report or a
  change is not something it can answer. Its `offer_game_agent` tool puts the switch to the user
  as a `ChatConfirmation` card (Agent Mode mounts one, keyed by the session) and asks the model
  for two things: the request in the user's words, which the card shows, and a `summary` of the
  game written for the agent taking over. Game Agent must not have the tool — it already has what
  the offer buys. It is dispatched by name through `storeTools` on `createAgentTurnRuntime`
  rather than `tools/agentBridge`: the bridge is inside the store's own import graph, so reaching
  back into the store from there closes a cycle and drags the whole store graph into everything
  the bridge loads from (it broke an unrelated test the first time).
  - **The switch runs after the offering turn ends, and runs the first Game Agent turn itself.**
    Accepting only records `pendingHandoff`; the store's `watch(processing)` — the same one that
    settles abandoned confirmation cards — then switches preset, starts a session and sends
    `gameAgentHandoffPrompt` as its first message, so the user watches the work continue instead
    of being handed a prompt box. It cannot happen inside the tool: `generate()` there would nest
    a turn inside the open one, and moving the preset mid-turn would file the one-shot run itself
    under Game Agent (`snapshotSession` freezes `presetName` only on a record that already
    exists).
  - **It is a new session, not the old one re-tagged.** Re-tagging kept the transcript, and that
    was the problem: a Quick Coder transcript is a plan and one `write`, written under
    instructions ("there is no browser", "you cannot read the file back") that are wrong for the
    agent inheriting it, and models followed them. The new session starts empty on the same
    folder, so the hand-over message is the whole context: what was built (the model's `summary`,
    or the library card when it sent none), what the user asked for, and that the folder holds a
    single `index.html` with no `game.js`. The one-shot record is kept — both sessions list under
    either games preset, and `adoptWorkspace`'s latest-wins reopens the Game Agent one.
  - Game Agent's prompt and the `html-game-studio` skill both say that a folder with **no
    `game.js`** holds a finished single-file game to change, not a scaffold to grow, and that the
    hand-over message is all it will be told about how the game came about.
- **Gotcha:** a `media` call temporarily switches the active preset to an image-gen one, so
  anything derived from the active preset must not follow it — `agentMode.activeAgentPreset`
  remembers the last agent preset for exactly this reason (following it live aborted the turn
  that made the call).
- **Gotcha:** models ask for a game's whole spritesheet in one step, and both Pi and the AI SDK
  dispatch those tool calls in parallel. All media work therefore queues on
  `assets/js/tools/mediaPipeline.ts` — one lane for a whole `media` request, one for a single
  ComfyUI run, nested in that order only. Without it the queued runs saw no progress and their
  watchers failed them as "stalled (no progress for 5 minutes)", and the runs stole each other's
  preset and generated items. Never take the ComfyUI lane and then wait on the request lane.
  With **Keep Models Loaded** off, a run that still sees work queued behind it
  (`comfyRunsWaiting()`) skips freeing ComfyUI and reloading the LLM, so a batch of generations
  costs one model swap instead of one each; the last run out does the cleanup.

### Verifying Home Agent features (LAN chat)

**`local-web` is the way to drive the Home Agent by hand.** It needs no Telegram/Slack
credentials — a password and a browser tab on loopback — and it goes through the same
`processChannelMessages` → `drainCommonQueue` → handlers path in `store/homeAgent.ts` that
every other channel does, so what works there works there for real. (A dev-only in-memory
`mock` channel used to exist for this; it was removed once the LAN page could do the job,
and unlike the mock it also proves the Python side and the served page.)

Set it up in the Home Agent setup screen (the gear next to the title-bar toggle), then open
the printed URL and log in. From there `/help`, `/imgGen`, `/reset`, an image attachment or
a plain chat prompt all exercise the real pipeline, including the outbound media path.

**What needs a model vs. not:** slash commands like `/help`, `/cancel`, `/reset` are
deterministic and need no LLM. Chat/agentic turns and `/imgGen` require a selected chat
model (and ComfyUI for image gen) — see "Testing inference end-to-end" above to get a
model ready first.

Automated coverage: `electron/test/channels/adapters.test.ts` and
`electron/test/subprocesses/localWebConfig.test.ts` for the units,
`e2e/home-agent-local-web.spec.ts` for the whole page in a real browser window.

### Tracing agent and chat turns (Laminar)

To judge a change to the agentic system you need the turn's shape, not its final answer:
how many steps it took, which tools it called, how many prompt tokens each step paid for
and how many of those the server actually reused. [Laminar](https://github.com/lmnr-ai/lmnr)
is an OpenTelemetry trace viewer for exactly that, and both halves of the app can feed it —
Pi agent runs from the main process, Vercel AI SDK chat turns from the renderer.

**It is off unless you opt in.** Nothing is imported, initialized or sent without
`WebUI/external/laminar.dev.json` or `WebUI/external/laminar.localhost.json` (both
gitignored; copy `laminar.dev.example.json`). The app prefers `.dev.json` (the team's
self-hosted instance) and falls back to `.localhost.json` (local compose). Every failure
path logs a warning and leaves tracing off — an observability problem must never cost a
turn or a startup.

**An installed build traces too, on the same terms.** The interesting turns happen on test
machines, not on the laptop that built them, so the config file is the only switch: drop
`laminar.dev.json` into the installed app's `resources` folder (next to `models.json`) and
restart. No config is ever shipped, so a project API key cannot ride along in an installer,
and an install without one behaves exactly as before. What this costs is package weight:
`@lmnr-ai/lmnr` and `@lmnr-ai/pi-extension` are `dependencies` rather than
`devDependencies` (~25 MB, and 38 transitive packages including gRPC and the OpenTelemetry
exporters), so they belong in the third-party notices. Both are `asarUnpack`ed: Pi loads
the extension from its **TypeScript source** through jiti, which wants a real path on disk.
The import stays dynamic regardless — a build that somehow lacks the SDK must lose its
traces, not its startup.

**Point the app at an instance.** Which Laminar it is does not matter — the team's
self-hosted one, Laminar Cloud, or a stack you brought up yourself — because the
config file is the only thing that decides where traces go:

```json
{
  "projectApiKey": "<from that instance's project settings>",
  "baseUrl": "https://api.laminar.aipg.aws.thenerdgroup.ai",
  "httpPort": 443,
  "grpcPort": 8443
}
```

`baseUrl` carries no port: the SDK splits the endpoint because traces and project metadata go
to different ones, and the defaults (`http://localhost`, 8000 / 8001) are the compose stack's,
so a local instance needs only the key. A shared instance's URL and ports come from whoever
runs it — keep both, and the key, out of the repo: a project API key writes into that
project's traces. Delete both files to switch tracing back off. Comparing runs across machines
is what the trace metadata is for (`hostname`, `backend`, `deviceName` — see the table below),
so several developers can share one instance and still tell their turns apart.

**A local instance** is a clone of Laminar next to this repo (compose stack: postgres +
clickhouse + quickwit + app-server + frontend, ~28 GB of images):

```bash
git clone https://github.com/lmnr-ai/lmnr ../lmnr && cd ../lmnr
cp .env.example .env   # then set LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL_{SMALL,MEDIUM,LARGE}
docker compose up -d   # UI on :5667, ingestion on :8000 (http) / :8001 (grpc)
```

`LLM_*` only powers Laminar's own AI features (chat-with-trace, evaluator authoring); any
OpenAI-compatible gateway works and the models must exist on it (`GET /v1/models`).
Sign up at `http://localhost:5667`, then copy a project API key from its project settings into
`laminar.localhost.json`. The team's self-hosted instance is at
`https://laminar.aipg.aws.thenerdgroup.ai` (ingestion
`https://api.laminar.aipg.aws.thenerdgroup.ai`, ports 443 / 8443) — put that key
in `laminar.dev.json`.
Cap the containers' logs in a `docker-compose.override.yml` (`max-size` / `max-file`) and
watch the Docker disk: a runaway ClickHouse log grew to 45 GB here, and once the disk is full
the stack stops accepting traces and postgres crash-loops, which reads like the app broke.

**Agent turns** are traced by Laminar's own `@lmnr-ai/pi-extension`, handed to Pi through
`additionalExtensionPaths` (`piAgentManager.ts`) — not a capability, since it is not
something a user picks per session. One trace per run: `pi agent run` → `LLM call (turn N)`

- one span per tool, carrying the session id, turn index, model, finish reason and
  `gen_ai.usage.*` including `cache_read_input_tokens`, which is the number to watch when
  changing anything that rewrites prompt history (see "Reasoning is set for the expensive
  case" above for why).

**Chat turns** are traced through the renderer, which is why there are two files:

- `electron/laminar.ts` — config, SDK init, shutdown flush, the Pi extension path, **and**
  the AI SDK integration running on the renderer's behalf.
- `src/lib/laminarTelemetry.ts` — the renderer half: an AI SDK 7 `Telemetry` integration
  that serializes each event and ships it over IPC.

**What each turn is tagged with.** Laminar has no tokens-per-second of its own (its dashboard
example is `total_tokens / duration`, which mixes prefill into generation), and nothing in the
`gen_ai.*` conventions records which of our backends ran a turn — so both are added here.
Trace-wide facts go on the trace as metadata (`lmnr.association.properties.metadata.<key>`,
what the Traces page filters on), per-call numbers go on the LLM span. Ours are namespaced
`aipg.*` so they can never collide with a reserved `lmnr.*` / `gen_ai.*` key.

| Where          | Key                                                                   | Value                                                        |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| trace metadata | `backend`                                                             | `llamaCPP` / `openVINO` / `cloud`                            |
| trace metadata | `device`                                                              | selected device id (`GPU.0`, `NPU`, …), local only           |
| trace metadata | `deviceName`                                                          | that device's display name (`Intel Arc B580`, …), local only |
| trace metadata | `hostname`                                                            | `os.hostname()` of the machine that produced the trace       |
| trace metadata | `cloudProvider`                                                       | provider id, cloud only                                      |
| trace metadata | `backendVersion`                                                      | llama.cpp build number / OVMS version, local only            |
| trace metadata | `serverArgs`                                                          | the running LLM server's whole command line, local only      |
| trace metadata | `preset`                                                              | preset the turn was held with, both surfaces                 |
| trace metadata | `agentType`                                                           | `agent` / `game-agent` / `quick-coder`, agent only           |
| trace metadata | `capabilities`                                                        | capability ids, sorted and comma-joined, agent only          |
| trace metadata | `appSession`                                                          | our `aipg-agent-*` session id, agent only                    |
| trace metadata | `game`, `gameId`                                                      | the game's title as of this turn, and its folder slug        |
| trace metadata | `genTps`, `prefillTps`, `llmCalls`                                    | the whole run's two speeds, and how many calls made them     |
| LLM span       | `aipg.thinking`, `aipg.reasoning_effort`                              | what the turn actually asked the template for                |
| LLM span       | `gen_ai.request.temperature` / `top_p` / `max_tokens`                 | the sampling that rode the request                           |
| LLM span       | `aipg.prefill_tokens_per_second`, `aipg.generation_tokens_per_second` | the two speeds, kept apart                                   |
| LLM span       | `aipg.prompt_ms`, `aipg.predicted_ms`, `aipg.cache_n`                 | what those speeds were computed from                         |

Both surfaces feed one stamper (`electron/laminarAttributes.ts`), which the span processor
calls on span start (metadata) and span end (the numbers). The facts reach it differently
because the two halves of the app know different things:

- **Backend, device, thinking, sampling** are the renderer's to know. Agent turns carry them
  on `AgentModeModelConfig` (`backend`, `device` and `deviceName` are there for tracing — a
  loopback port says nothing about which server is behind it); chat turns send one extra IPC
  event per turn on the telemetry channel (`aipgChatContext`), built from the same
  `chatTemplateKwargs` call that builds the request body, so a trace cannot claim something
  the model was never sent.
- **Hostname** is main's: `os.hostname()`, stamped on every root span so two test boxes
  ingesting into one Laminar stay filterable. Cloud turns get it too.
- **Version and launch line** stay in main and are never copied into the renderer:
  `electron/llmServerSnapshot.ts` reads them off the live service (and the selected device's
  display name, as a fallback when the renderer did not send `deviceName`). Flags are baked
  into the process at launch, so `llamaCppBackendService` / `openVINOBackendService` remember
  the argv they started their LLM server with.
- **Speeds** come from llama.cpp's own `timings` whenever it sent them — it separates prefill
  from generation and reports the prompt-cache hit (`cache_n`). Chat already parsed that object
  for the message footer and now forwards it (`aipgChatTimings`); agent turns ask for it
  (`timings_per_token: true`, added only for llama.cpp and only while tracing) and read it off
  the response stream in `electron/agentMode/piCallTiming.ts`. OVMS and cloud have no such
  object, so those get prompt tokens over time-to-first-token and completion tokens over the
  rest — the same split, measured from outside.

**An agent run is labelled, or thirty of them are one row repeated.** The Traces list shows a
trace's root span name plus its metadata column, so every run used to read `pi agent run` and
differ only by machine. `electron/agentMode/agentRunIdentity.ts` collects what the run is —
preset (carried into main on `AgentModeTurnConfig.presetName`, since main has the instruction
text but not the name), `agentType` derived from the capability ids, the ids themselves, our
session id and the game — and `laminarAttributes.ts` stamps those as metadata and renames the
root span to `<preset> · <game>`, falling back to the preset and leaving `pi agent run` when it
knows nothing. Worth knowing:

- **The rename is scoped to the name Pi gives its root span**, so nothing else can be caught by
  it, and it is the only span name we touch.
- **The identity is a getter, read per span**, because the agent names its game mid-run with the
  `game` tool. Laminar merges a trace's metadata last-write-wins, so a trace settles on the name
  as of the turn that produced it while `gameId` (the folder) never moves.
- **It is registered per turn** (`piTurnRunner.startAgentTurn`), not per session like the
  inference context: a resumed session keeps its model but its game may have been named since.
  The preset is the _remembered_ agent preset, never the live active one — a `media` call
  switches the active preset to an image-gen one mid-turn.
- **Render templates cannot do this.** They render inside a trace (a span pane, or a whole-trace
  custom view beside Tree/Transcript); the overview reads the root span name and the metadata
  column, and a [table view](https://laminar.sh/docs/platform/table-views) saves a column layout
  plus filters as a named project preset — that is where `agentType` earns its low cardinality.

**A run's speed is summed here, because the Traces list cannot sum it.** A custom column in that
list is a ClickHouse expression over the _trace row_, and the per-call speeds live on the child
LLM spans (inside `spans.attributes`, a JSON string) — Laminar's own per-trace numbers (tokens,
cost, duration) are likewise aggregated at ingestion, not by the list query. So `laminarAttributes.ts`
accumulates each call's contribution and stamps the totals as trace metadata, which a column then
reads with no subquery:

| Column        | SQL (`dataType: number`)                         |
| ------------- | ------------------------------------------------ |
| Gen tok/s     | `simpleJSONExtractFloat(metadata, 'genTps')`     |
| Prefill tok/s | `simpleJSONExtractFloat(metadata, 'prefillTps')` |
| LLM calls     | `simpleJSONExtractFloat(metadata, 'llmCalls')`   |

Add them under Columns → custom column and save the layout as a table view; they sort and filter
like built-in columns. What the numbers mean:

- **Summed, not averaged.** `genTps` is total generated tokens over total generation time, so a
  five-token reply cannot count as much as a two-thousand-token one — a plain mean of the per-call
  figures would make a long agent run look as fast as its shortest step.
- **Tokens are recovered from each span's own speed and duration**, not read off `gen_ai.usage.*`:
  the total then cannot disagree with the spans it is made of, and a prompt served from the
  server's cache is not counted as prefill work that never happened.
- **Every model call in the trace counts, the media specialist's included** — it is the same
  backend serving the same run.
- **The totals land on the run's root span**, the last one to end: Laminar merges a trace's
  metadata last-write-wins in ingestion order, so writing a running total on each LLM span would
  settle on an arbitrary one. The root is matched by span id (remembered when it starts), which is
  why renaming it above does not lose it. Agent runs are recognized by `pi agent run`, chat turns
  by the AI SDK operation names — a nested `ai.llm` must never be mistaken for a root, so the
  match is by name rather than by absence of a parent.

**Media generation is traced too, from the renderer.** A `media` call used to be one opaque
TOOL span covering the whole IPC wait, which is unhelpful for the question it is usually asked
about ("why did that cover image take four minutes"): starting ComfyUI, swapping the LLM off
the GPU, pulling a checkpoint and running the workflow all happen in the renderer. The same
bridge as chat telemetry carries them — two more events on `laminarTelemetryEvent`,
`aipgSpanStart` `{ id, name, input?, attributes?, parentId? }` and `aipgSpanEnd`
`{ id, attributes?, output?, error? }` — with the sending half in `src/lib/laminarSpans.ts`
(`startTraceSpan` for a phase whose end is decided elsewhere, `withTraceSpan` around one
await; both no-ops unless tracing is configured) and the receiving half in
`electron/laminarSpans.ts`. An agent cover-image call then reads:

```
pi agent run
└─ media (TOOL)                      duration of the IPC wait
   ├─ ai.streamText                  the media specialist's own run
   │  ├─ ai.llm model.chat:<model>   picks the workflow, writes the prompt
   │  ├─ ai.tool comfyUI             its call into the pipeline
   │  └─ ai.llm model.chat:<model>   reports what came back
   ├─ backend.stop_llm               keepModelsLoaded off
   ├─ models.download                only when files were missing
   ├─ comfyui.generate               the run's parameters (below)
   │  ├─ comfyui.start_backend
   │  ├─ comfyui.install_nodes       only when custom nodes/packages ran
   │  ├─ comfyui.load_workflow_components
   │  ├─ comfyui.load_model          one per loader node, naming the model file
   │  └─ comfyui.generating          progress as attributes, not a span per step
   └─ backend.reload_llm             last run in the lane; skipped when more wait
```

Things to know before changing it:

- **The GPU swaps are siblings, not children**, because `stopChatBackends()` runs before
  `generate()` exists and `returnGpuToChat()` after it has settled — the media tool span is the
  only thing open around all three. The `comfyRunsWaiting()` skip stays visible as an absent
  `backend.reload_llm` on intermediate sprites, and desktop Image Gen simply has neither.
- **The open media TOOL span is remembered as the parent**, since neither Pi nor the AI SDK
  puts its tool spans on the OpenTelemetry active context — `Laminar.withSpan` around the IPC
  dispatch would parent nothing. What both do is create spans through the SDK's tracer, so the
  stamping processor sees them: `noteSpanStart` keeps the ones named after a media tool
  (`media`, `generateImage`, `editImage`, `comfyUI`, `comfyUiImageEdit` — the AI SDK prefixes
  `ai.tool `, and sets the span type one statement _after_ creation, so the name is all there
  is to match on at start). A renderer span with no `parentId` attaches to the **oldest** open
  one: models ask for a whole spritesheet at once and both harnesses dispatch those calls in
  parallel, while the media pipeline runs them one at a time in call order, so the oldest open
  media tool span is the run being served. Its `LaminarSpanContext` carries Pi's session id and
  the trace metadata along, so children land in the agent's session for free. With no tool span
  open (desktop Image Gen) `comfyui.generate` is a root, still stamped with `hostname`.
- **`comfyui.generate` outlives the call that opened it.** `generate()` returns once the prompt
  is queued (or earlier, when the backend is still starting and the run continues in an
  auto-retry); everything after that is websocket-driven. So the span is opened in `generate()`
  and closed where the generation FSM settles — the same watch that ends the generation
  activity — and the phase spans are switched there by state, one per phase.
- **Late attributes ride the end event.** A span reaches Laminar when it ends, so per-tick
  progress updates would be IPC nobody reads; `setAttributes` accumulates in the renderer and
  is sent once with `aipgSpanEnd`. `setInput` rides along for the same reason from the other
  side: `comfyui.generate` has to open before the backend starts, and its parameters exist only
  after the workflow has been rewritten.
- **What a generation was asked for is recorded twice, in two shapes.**
  `src/lib/comfyTraceParameters.ts` turns the resolved run into curated scalars —
  `aipg.variant`, `aipg.seed` (the resolved one, never the `-1` wildcard), `aipg.steps`,
  `aipg.width`/`height`/`resolution`, `aipg.models`, `aipg.source_image`, and `aipg.items_done`
  at the end, beside the preset/mode/batch-size keys the span already had — plus the whole
  picture as the span's input JSON: prompts and one entry per workflow input, keyed
  `<nodeTitle>.<nodeInput>`, so a preset's own knobs (checkpoint, LoRA, guidance, sampler) are
  there too. Attributes are what Laminar's SQL groups by, which is why they stay scalar and few.
  **Redaction is part of the contract:** image-shaped inputs (`image`, `video`, `inpaintMask`,
  `outpaintCanvas`) hold a base64 data URI of a whole image, so they are described
  (`<image/png, 293 KB>` / `<none>`) and never serialized — a data URI in any other input is
  described the same way rather than trusted — while short references (`aipg-media://…`, a file
  name) stay verbatim, since that is what identifies a source image. Every other string is
  capped. The module is pure, so it is unit-tested directly
  (`electron/test/lib/comfyTraceParameters.test.ts`) and the store stays wiring.
- **A workflow that loads two models stays in one FSM state.** `load_model` is entered once and
  never re-entered between a unet and a clip, so a span switched by the state watch would cover
  both and say nothing about which was slow. The websocket's `executing` branch opens the phase
  span itself, and `enterPhaseSpan` compares name **and** loader node before deciding it is
  already in the right span. Each one carries `aipg.node` and `aipg.model`, read off the
  loader's `*_name` input in the already-normalized workflow.
- **The specialist's own model calls have to be pulled in, and say so themselves.** The media
  agent is a nested AI SDK run (`agents/toolAgent.ts`), so it is traced by Laminar's AI SDK
  integration, which reads a call's parent off the OpenTelemetry context — where nothing has
  put the tool span. Left alone it makes `ai.streamText` a root, and the two calls that decide
  and then narrate a generation form a trace beside the trace holding the generation itself.
  `runMediaAgent` therefore sends `noteChatTraceContext({ ...chatTraceContext(), delegated: true })`
  before its run, and `handleChatTelemetryEvent` creates that run's `onStart` inside
  `Laminar.withSpan(openMediaToolSpan())`. The declaration is **spent on one run** (one
  `streamText` sends one context and fires one `onStart`) because in Agent Mode the parent turn
  is Pi, in main, and never sends a context that would clear it — a flag left standing would
  adopt the next unrelated AI SDK call. Note the specialist's `ai.tool comfyUI` and our
  `comfyui.generate` end up siblings rather than nested: renderer spans attach to the oldest
  open media tool span, deliberately, so parallel spritesheet calls cannot steal each other's.
- **The specialist's trace context is the same one chat sends**, from `chatTraceContext()` in
  `src/lib/chatModel.ts` (moved out of the chat store when the second caller appeared). Without
  it a delegated LLM span was stamped with whatever the last chat turn happened to set, or with
  nothing at all in Agent Mode, where no chat turn ever runs.
- Spans that would describe nothing are not created at all: no `comfyui.install_nodes` when
  requirements were already met, no `models.download` when nothing was missing. Their absence
  is the informative part when comparing a first run against the next.

**Five gotchas are load-bearing, don't "simplify" them away:**

- **`maxChars` has to be big, or every follow-up turn loses its prompt.** The Pi
  extension records the outgoing message list on each LLM span and truncates it to
  `LMNR_MAX_CHARS` (its own default: 20000) _keeping the front_. Laminar's transcript does
  not read the prompt off the root span — it extracts it from that recorded list (first and
  last element, `INPUT_QUERY` in `frontend/lib/actions/sessions/trace-io.ts`). So from the
  second turn of a session onwards, where the front is system prompt plus old history and
  the new user message sits at the end, the clip lands mid-array: the JSON no longer parses,
  the server stores the raw string instead of a message array, and the trace and session
  views show no **Input** at all. `initLaminarTracing` therefore sets `LMNR_MAX_CHARS` from
  the config's `maxChars` (default 1M) before the first Pi session. A useful tell when
  checking this in ClickHouse: `length(input) = 0` on an LLM span is the _healthy_ state
  (parsed, stored canonically), while a non-empty `input` ending in
  `… [truncated N chars]` is the broken one.

- **Initialize the SDK in main before the first Pi session.** The Pi extension calls
  `initTracing` itself but passes only `baseUrl`, so against a self-hosted instance it
  exports to the cloud's default ports and every span silently vanishes. Its init is a
  no-op once the SDK is initialized, so winning that race is what makes `httpPort` /
  `grpcPort` stick. `forceHttp: true` avoids needing the gRPC exporter's native addon
  inside Electron.
- **`@lmnr-ai/lmnr` cannot run in the renderer.** It is a Node library (it reaches for
  `createRequire` and dies on Vite's browser stub) and the page has `nodeIntegration` off,
  which is worth keeping. But AI SDK 7 telemetry is plain data keyed by `callId`, and
  Laminar's integration is data-driven too, so the renderer forwards events over IPC
  (`laminarTelemetryEvent`) and main replays them into the real `LaminarAiSdkTelemetry`.
  Span mapping, the exporter and the project key all stay in main. `onChunk` is not
  forwarded — it fires per streamed chunk (thousands of IPC messages per reply) and only
  feeds a time-to-first-token attribute.
- **The stamping processor must not be a `LaminarSpanProcessor`.** `Laminar.initialize`
  wraps whatever `spanProcessor` it is given in a fresh one of its own, and for an instance
  of its own class it lifts out the inner processor and discards the object — so a patched
  `LaminarSpanProcessor` is silently thrown away and not one attribute of ours is stamped
  (it took a full round of "why is the trace empty of our keys" to find). Anything else is
  kept and called, which is why `stampingSpanProcessor` returns a plain object that wraps a
  real one. Its `onStart` is also the only chance to write trace metadata: Pi's spans are
  parentless at start (they are linked by path attributes afterwards), so for agent runs the
  metadata lands on every span, while a chat turn's lands on `ai.streamText` alone.
- **Measure a call from before `fetch` resolves.** A streaming server answers with headers as
  soon as it has the first token, so timing the response object puts prefill at ~1 ms and
  reports millions of tokens per second — which is exactly what the first cloud agent trace
  claimed.

**Verify it:** start `npm run dev` (or the installed app, whose main log is the same one),
look for `[laminar]: tracing to <your instance>` in the
main log (it prints the endpoint it resolved, so a typo in the config shows up here) and
`[laminar] chat traces via main to …` in the renderer console, then send one Chat turn and one
Agent turn and open the instance's UI → traces. A chat turn appears as `ai.streamText` →
`ai.llm model.chat:<model>`; an agent turn as the `pi agent run` tree above. For the media
spans, one Game Agent cover image (`Draft Image`) should show `media` with `comfyui.generate`
and the `backend.*` swaps under it, and one desktop Image Gen click a `comfyui.generate` root
carrying `hostname`. If the UI shows nothing, query the store directly rather than guessing —
against a local stack that is its ClickHouse container, against a shared one Laminar's own SQL
editor asks the same question:

```bash
docker exec clickhouse clickhouse-client --query \
  "SELECT name, span_type, model, input_tokens, output_tokens FROM default.spans ORDER BY start_time DESC LIMIT 20"
```

The added keys read back the same way, in that query or in Laminar's own SQL editor — this is
also the quickest check that a turn was tagged at all:

```sql
SELECT
  name,
  JSONExtractString(attributes, 'lmnr.association.properties.metadata.hostname') AS host,
  JSONExtractString(attributes, 'lmnr.association.properties.metadata.backend') AS backend,
  JSONExtractString(attributes, 'lmnr.association.properties.metadata.deviceName') AS device,
  JSONExtractFloat(attributes, 'aipg.prefill_tokens_per_second') AS prefill_tps,
  JSONExtractFloat(attributes, 'aipg.generation_tokens_per_second') AS gen_tps,
  JSONExtractString(attributes, 'aipg.thinking') AS thinking
FROM default.spans
WHERE span_type = 1
ORDER BY start_time DESC
LIMIT 20
```

Smoked on all three paths: a llama.cpp chat turn and a llama.cpp agent step (llama.cpp's own
timings, `backendVersion`, the full `serverArgs`, `aipg.thinking`) and a cloud agent step
(`backend=cloud` + provider id, measured speeds, no server args). OVMS could not be smoked on
macOS — no OpenVINO LLM models are offered there — but it takes the same measured fallback as
cloud and the same snapshot reader as llama.cpp.
