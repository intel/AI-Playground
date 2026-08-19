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

## Build / Dev / Test Commands

All commands run from the **`WebUI/`** directory.

```bash
# Install dependencies
npm install

# Start dev server + Electron
npm run dev

# Run all tests once
npm test

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

**Architecture:** `vite --mode test` serves only the renderer (the Electron plugin is
skipped in test mode — see `vite.config.mts`); the fixture launches the built Electron
main (`dist/main`, built on demand) pointed at that dev server via `VITE_DEV_SERVER_URL`.

**Only one instance of the app can run at a time** — a single-instance lock (a named
mutex on Windows) makes a second launch attach to the existing instance instead of
starting fresh. This applies to e2e too: close any running dev/app instance before an
e2e run, and the suite never runs the app in parallel — it is serial (`workers: 1`,
`fullyParallel: false`) and each test launches then closes its own Electron. A
not-fully-reaped Electron from a previous run can make the next launch attach and quit
with no window ("No Electron windows appeared"); the launch fixture retries once to ride
out that flake.

**Files:** `fixtures.ts` (launch + `window`/`app` fixtures), `appDriver.ts` (`AppDriver`,
the high-level entry point; exposes `wizard`, `shell`, `main`, `settings`), `pages/*.ts`
(Page Objects: `SetupWizardPage`, `AppShellPage`, `MainPage` = prompt area + results,
`SpecificSettingsPage` = the preset settings sidebar, `HomeAgentPage` = Home Agent setup +
title-bar master toggle), `backends.ts` (parametric model + types), `helpers.ts`,
`agentic-smoke.spec.ts` (quick `e2e` gate), `assistant-media-flow.spec.ts` (full agentic
reference spec: install + image → edit → video), and for the LAN chat channel
`localWebBrowser.ts` (drives the *served page* in a real BrowserWindow, so a break in the
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
- **Deactivate a backend with its toggle, not the feature flag.** For "no Home Agent",
  `wizard.disableBackend('Home Agent')`; do not touch `isHomeAgentEnabled`.
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
  *including just switching to a mode whose last-used preset is gated* — so it can appear
  before any step you control and its backdrop then eats clicks. Handle it globally with
  `page.addLocatorHandler` (registered in the `window` fixture), scoped by message so it
  never touches unrelated warnings; the handler ticks "Do not show again" and confirms.
- **First use of a preset downloads its models.** On a fresh machine almost every preset
  (chat/image/video) opens the blocking model-download dialog (`DownloadDialog`,
  `role="dialog"` + `aria-label="Model download"`) on the first send/generate. `AppDriver`
  clears it via `DownloadDialogPage.resolve()` at every send point; gated models with no HF
  access can't be confirmed, so those tests `test.skip` instead of hanging.
- **Timeouts:** the default chat model (Qwen3.5-9B) is a *reasoning* model — its thinking
  alone can exceed 2 min, so per-turn budgets are minutes (`TEXT/IMAGE/VIDEO_TIMEOUT`), applied
  *after* any model download is handled separately.
- **"Close" is ambiguous** — the header's window-close (X) control is `title="Close"`, so an
  unscoped `getByRole('button', { name: 'Close' })` can match it and **quit the app**. Scope
  sidebar closes to their region (`getByRole('region', { name: '<title>' })`, via
  `SideModalBase`'s `role="region"`), and prefer a uniquely-named button (e.g. the wizard's
  "Continue") over "Close".
- **Channel config outlives the test run** (it is stored in `safeStorage`, not in the app
  window), so a channel setting is only what this test asserts if the test *drives it to the
  value it wants* — `configureLocalWeb` unchecks LAN access when it wasn't asked for, rather
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
  lingers needs `noWaitAfter: true`. Beware too that *any* action or assertion triggers a
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

### Pinia Stores

- Use setup syntax: `defineStore('name', () => { ... })`.
- Enable persistence with `{ persist: true }` option where needed. Properties picked for persistence need to be returned, even if they are not used externally.
- Add HMR support: `if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(...))`.
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

| Element               | Convention   | Example                          |
|-----------------------|-------------|----------------------------------|
| Vue components/files  | PascalCase  | `ModelSelector.vue`              |
| Store files           | camelCase   | `backendServices.ts`             |
| Functions/variables   | camelCase   | `startService`, `currentStatus`  |
| Types                 | PascalCase  | `BackendStatus`, `ModelPaths`    |
| Store composables     | `use` prefix| `useBackendServices()`           |
| Backend service names | kebab-case  | `'ai-backend'`, `'comfyui-backend'` |
| Python modules        | snake_case  | `web_api.py`, `llm_biz.py`      |

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
spellings (e.g. `/imgGen`). The dev mock channel bypasses all of this (it injects raw text straight
into the dispatcher), so a command working there does NOT prove it works on Telegram/Slack.

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
- Once running, `promptStore.currentMode` controls which view renders: `chat` → `Chat.vue`, `imageGen`/`imageEdit`/`video` → `WorkflowResult.vue`
- `PromptArea.vue` is the shared prompt input bar across all modes

### Backend Services (4 services, dynamic ports)

Managed by `electron/subprocesses/apiServiceRegistry.ts`. Each service spawns a child process and exposes an OpenAI-compatible HTTP API:

| Service | Ports | Binary/Entry | Health Endpoint | Purpose |
|---|---|---|---|---|
| `ai-backend` | 59000-59999 | `service/web_api.py` (Python Flask) | `/healthy` | Model downloading/management only — **NOT inference** |
| `llamacpp-backend` | 39000-39999 | `llama-server` (native) | `/health` | GGUF model inference (LLM + embedding sub-servers) |
| `openvino-backend` | 29000-29999 | `ovms` (native) | `/v2/health/ready` | OpenVINO inference (LLM + embedding + transcription sub-servers) |
| `comfyui-backend` | 49000-49999 | ComfyUI `main.py` (Python) | `/queue` | Image/video/3D generation via workflows |

### Three Communication Patterns

1. **Electron IPC** (renderer ↔ main): ALL service lifecycle — start, stop, setup, device selection, `ensureBackendReadiness`. Renderer calls `window.electronAPI.*`, main handles via `ipcMain.handle()`. Main pushes events via `win.webContents.send()`.

2. **Direct HTTP** (renderer → backend): For actual AI operations after service is ready:
   - **Chat inference**: Vercel AI SDK `streamText()` → `{backendUrl}/v1/chat/completions` (LlamaCpp/OpenVINO)
   - **Model management**: `fetch()` → Flask ai-backend `/api/*` (download, check, size)
   - **Image generation**: `fetch()` → ComfyUI `/prompt`, `/upload/image`, `/interrupt`, `/free`

3. **Utility process** (main ↔ langchain worker): `electron/subprocesses/langchain.ts` for RAG document processing via `process.parentPort` messaging.

### Chat Inference Flow

User sends message → `textInference.ensureReadyForInference()` → IPC `ensureBackendReadiness` (loads model on-demand) → `openAiCompatibleChat` uses Vercel AI SDK `streamText()` → direct HTTP to backend's `/v1/chat/completions` → streamed response.

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

**Settings/config**: `getInitSetting`, `updateLocalSettings`, `getThemeSettings`, `getLocaleSettings`, `getInitialPage`, `getDemoModeSettings`

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
- `promptArea` — Current UI mode (`chat`/`imageGen`/`imageEdit`/`video`), prompt submit/cancel callbacks. Deps: `presetSwitching`

**Infrastructure stores** (UI state, no business logic):
- `errors` — **Central error sink.** `report(err, overrides?)` normalizes any value into an `AppError`, logs it, de-duplicates (by instance), and surfaces it per its `surface` policy (toast/inline/modal/silent). Keeps `recentErrors`. No deps. See "Error & generation state architecture" below.
- `activities` — **Central activity/progress sink.** `begin/update/end/track` long-running steps; `chatActivity(key, exclude?)` / `imageGenActivity` expose the most-specific active work; `endScope()` reconciles stragglers. Single source of truth for "what is the app busy with" (backend prep, RAG, tools, thinking, generation). No deps. See "Error & generation state architecture" below.
- `dialogs` — Dialog visibility state (download, warning, requirements, installation progress, mask editor). No deps.
- `ui` — History panel visibility. No deps.
- `theme` — Theme selection. IPC: `getThemeSettings`. No deps.
- `i18n` — Locale/translations. IPC: `getLocaleSettings`. No deps.
- `demoMode` — Demo mode overlay + auto-reset timer. IPC: `getDemoModeSettings`. No deps.
- `speechToText` — STT enabled state, initialization. Deps: `backendServices`, `models`, `dialogs`, `globalSetup`
- `audioRecorder` — Browser MediaRecorder, transcription via AI SDK. Deps: `backendServices` (lazy)
- `developerSettings` — Dev console on startup toggle. No deps.

### Feature → File Map

**Chat/LLM**: `views/Chat.vue` → stores: `openAiCompatibleChat`, `textInference`, `conversations`, `presets` → electron: `ensureBackendReadiness` IPC → backend: `llamacpp`/`openvino` via Vercel AI SDK

**Image/Video Generation**: `views/WorkflowResult.vue` → stores: `imageGenerationPresets`, `comfyUiPresets`, `presets` → electron: service lifecycle IPC → backend: `comfyui-backend` via direct HTTP

**Model Management**: stores: `models` → electron: `loadModels`, `getDownloaded*` IPC → backend: `ai-backend` Flask `/api/*` via HTTP

**Settings**: `components/settings/SideModalAppSettings.vue`, `components/settings/SideModalSpecificSettings.vue` → stores: `backendServices`, `textInference`, `imageGenerationPresets`, `theme`, `i18n`

**Presets**: `components/PresetSelector.vue`, `components/VariantSelector.vue` → stores: `presets`, `presetSwitching`

**Service Management**: `components/InstallationManagement.vue` → store: `backendServices` → electron: `apiServiceRegistry.ts`, `electron/subprocesses/*.ts`

### Electron Main Process Files

| File | Purpose |
|---|---|
| `electron/main.ts` | Window creation, all IPC handlers (~68 channels), app lifecycle |
| `electron/preload.ts` | `contextBridge` exposing `electronAPI` to renderer |
| `electron/pathsManager.ts` | Singleton managing all app/model/service filesystem paths |
| `electron/remoteUpdates.ts` | Fetching model lists and preset updates from GitHub |
| `electron/subprocesses/apiServiceRegistry.ts` | Service registration, port allocation, lifecycle orchestration |
| `electron/subprocesses/service.ts` | Base classes: `GenericService`, `ExecutableService`, `LongLivedPythonApiService` |
| `electron/subprocesses/aiBackendService.ts` | Python Flask model-management backend |
| `electron/subprocesses/llamaCppBackendService.ts` | LlamaCPP native server (LLM + embedding sub-servers) |
| `electron/subprocesses/openVINOBackendService.ts` | OpenVINO OVMS (LLM + embedding + transcription sub-servers) |
| `electron/subprocesses/comfyUIBackendService.ts` | ComfyUI Python server |
| `electron/subprocesses/langchain.ts` | RAG utility process (document splitting, embedding, vector search) |
| `electron/subprocesses/deviceDetection.ts` | Intel GPU device detection and env var setup |
| `electron/logging/logger.ts` | Logging, sends `debugLog` events to renderer |

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

A small test model (`LFM2.5-350M-Q4_K_M.gguf`, ~255 MB) is available in dev mode only.
It is injected by the models store (`WebUI/src/assets/js/store/models.ts`) when
`debugToolsEnabled` is true (i.e., when running via `npm run dev`). It is not listed
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

`local-web` ("LAN chat") is the odd one out: instead of talking to a cloud bot API it *is* the
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

### Verifying Home Agent features (mock channel)

A dev-only **mock channel** lets you exercise the full Home Agent message pipeline
(slash commands, agentic generation, image gen, confirmations) without Telegram/Slack
credentials or the `home-agent-backend` running. It bypasses IPC and Python entirely:
inbound messages come from an in-memory queue and every outbound send is captured
in-memory, so behavior is deterministic and inspectable.

- Only active in dev mode (`window.envVars.debugToolsEnabled`, i.e. `npm run dev`).
- Implemented as a normal `ChannelAdapter` (`kind: 'mock'`) so it flows through the real
  `processChannelMessages` → `drainCommonQueue` → handlers path in
  `store/homeAgent.ts`. No code special-cases tests beyond the inbound source (the bus)
  and `mock` activation (`debugToolsEnabled && masterEnabled`, no backend required).

**Files:**
- `src/assets/js/store/channels/mockAdapter.ts` — `mockChannelBus` (in-memory `inbox` +
  reactive `outbox`) and `createMockAdapter()`.
- `src/assets/js/store/homeAgent.ts` — `mock` wired into `KINDS` (dev-only), the per-kind
  maps, activation, mock poll source, and the `mockSend` / `mockSendCallback` /
  `mockOutbox` / `mockClear` / `mockWaitForIdle` store actions.
- `src/components/MockChannelPanel.vue` — dev-only floating UI panel (mounted in `App.vue`
  under `v-if="debugToolsEnabled"`) to type messages and watch captured output live.

**Drive it manually:** click the **beaker** icon next to the Home Agent setup gear in the
title bar (dev only) to open the panel, type a message (e.g. `/help`, `/imgGen`, or a chat
prompt), and inspect the captured replies.

**Drive it programmatically** (dev console, or the `user-chrome-devtools-aipg` MCP
`evaluate_script` against `http://localhost:25413`) via `window.__homeAgentMock`:

```js
window.__homeAgentMock.clear()
await window.__homeAgentMock.send('/help')          // inject a text message + drain
await window.__homeAgentMock.sendCallback('imgGen:cancel') // inject an inline-keyboard tap
await window.__homeAgentMock.waitForIdle()          // resolves when the drain loop is idle
window.__homeAgentMock.outbox()                     // captured outbound events

// Verify outbound media delivery WITHOUT a full generation: routes a media URL
// through the real send path (sendImageToChannel / sendVideoToChannel /
// send3DModelToChannel). For a .glb this renders the 3D thumbnail "screenshot"
// (captured as a `photo`) and ships the model (captured as a `document`).
await window.__homeAgentMock.sendMedia('aipg-media://AIPG_3D_00001_.glb')
```

`send(text, opts?)` accepts optional `images` / `audio` / `documents` / `chat_id` /
`channel` / `ts` (same shape as a channel poll item) — so inbound image attachments are
supported (agentic/photo turns also need a vision-capable chat model). `sendMedia(url,
opts?)` infers `image` / `video` / `model3d` from the extension unless you pass
`opts.kind`. Each outbox entry is
`{ kind, text?, caption?, filename?, mime?, base64?, buttons?, meta?, ts }` where `kind`
is one of `reply | photo | video | voice | document | keyboard | draftUpdate | draftFinal
| typingStart | typingStop`.

**What needs a model vs. not:** slash commands like `/help`, `/cancel`, `/reset` are
deterministic and need no LLM. Chat/agentic turns and `/imgGen` require a selected chat
model (and ComfyUI for image gen) — see "Testing inference end-to-end" above to get a
model ready first.

Unit coverage lives in `electron/test/channels/mockAdapter.test.ts`.
