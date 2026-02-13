# AGENTS.md — AI Playground

Concise reference for AI coding agents working in this repository.

## Project Overview

Electron + Vue.js desktop app for AI inference on Intel GPUs. Multi-process architecture:
Electron main process orchestrates Vue.js frontend and multiple Python/native backend services
(AI Backend, ComfyUI, LlamaCPP, OpenVINO, Ollama). Frontend code lives in `WebUI/`.

## Mandatory Rules

- Use **composition over inheritance** — never introduce new class hierarchies.
- Do **not** use classes unless extending an existing set of classes of the same type.
- Use **`type`** instead of `interface`, unless an interface is strictly necessary for implementation.

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

Python backend (`service/`) uses **Ruff** for linting (runs in CI via GitHub Actions).

## Test Conventions

- Framework: **Vitest 3.2+** with `node` environment.
- Test file pattern: `**/*.test.ts` (not `.spec.ts`).
- Path aliases: `@` → `./src`, `electron` → `./electron`.
- Tests use `describe` / `it` / `expect`. Mock Electron with `vi.mock('electron', ...)`.
- Tests live alongside source in `electron/test/` (currently unit tests for Electron main process only).

## Code Style

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

- Wrap async operations in `try/catch`.
- Log errors with `console.error()`.
- Show user-facing errors via toast: `import * as toast from '@/assets/js/toast'` then `toast.error(msg)`.
- IPC handlers return `{ success: boolean, error?: string }` pattern for error propagation.
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

### Backend Services (5 services, dynamic ports)

Managed by `electron/subprocesses/apiServiceRegistry.ts`. Each service spawns a child process and exposes an OpenAI-compatible HTTP API:

| Service | Ports | Binary/Entry | Health Endpoint | Purpose |
|---|---|---|---|---|
| `ai-backend` | 59000-59999 | `service/web_api.py` (Python Flask) | `/healthy` | Model downloading/management only — **NOT inference** |
| `llamacpp-backend` | 39000-39999 | `llama-server` (native) | `/health` | GGUF model inference (LLM + embedding sub-servers) |
| `openvino-backend` | 29000-29999 | `ovms` (native) | `/v2/health/ready` | OpenVINO inference (LLM + embedding + transcription sub-servers) |
| `comfyui-backend` | 49000-49999 | ComfyUI `main.py` (Python) | `/queue` | Image/video/3D generation via workflows |
| `ollama-backend` | 40000-41000 | `ollama` (native) | `/api/version` | Ollama inference (preview feature) |

### Three Communication Patterns

1. **Electron IPC** (renderer ↔ main): ALL service lifecycle — start, stop, setup, device selection, `ensureBackendReadiness`. Renderer calls `window.electronAPI.*`, main handles via `ipcMain.handle()`. Main pushes events via `win.webContents.send()`.

2. **Direct HTTP** (renderer → backend): For actual AI operations after service is ready:
   - **Chat inference**: Vercel AI SDK `streamText()` → `{backendUrl}/v1/chat/completions` (LlamaCpp/OpenVINO/Ollama)
   - **Model management**: `fetch()` → Flask ai-backend `/api/*` (download, check, size)
   - **Image generation**: `fetch()` → ComfyUI `/prompt`, `/upload/image`, `/interrupt`, `/free`

3. **Utility process** (main ↔ langchain worker): `electron/subprocesses/langchain.ts` for RAG document processing via `process.parentPort` messaging.

### Chat Inference Flow

User sends message → `textInference.ensureReadyForInference()` → IPC `ensureBackendReadiness` (loads model on-demand) → `openAiCompatibleChat` uses Vercel AI SDK `streamText()` → direct HTTP to backend's `/v1/chat/completions` → streamed response.

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
- `dialogs` — Dialog visibility state (download, warning, requirements, installation progress, mask editor). No deps.
- `ui` — History panel visibility. No deps.
- `theme` — Theme selection. IPC: `getThemeSettings`. No deps.
- `i18n` — Locale/translations. IPC: `getLocaleSettings`. No deps.
- `demoMode` — Demo mode overlay + auto-reset timer. IPC: `getDemoModeSettings`. No deps.
- `speechToText` — STT enabled state, initialization. Deps: `backendServices`, `models`, `dialogs`, `globalSetup`
- `audioRecorder` — Browser MediaRecorder, transcription via AI SDK. Deps: `backendServices` (lazy)
- `ollama` — Ollama model pull progress. Deps: `textInference`
- `developerSettings` — Dev console on startup toggle. No deps.

### Feature → File Map

**Chat/LLM**: `views/Chat.vue` → stores: `openAiCompatibleChat`, `textInference`, `conversations`, `presets` → electron: `ensureBackendReadiness` IPC → backend: `llamacpp`/`openvino`/`ollama` via Vercel AI SDK

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
| `electron/subprocesses/ollamaBackendService.ts` | Ollama binary (preview) |
| `electron/subprocesses/langchain.ts` | RAG utility process (document splitting, embedding, vector search) |
| `electron/subprocesses/deviceDetection.ts` | Intel GPU device detection and env var setup |
| `electron/logging/logger.ts` | Logging, sends `debugLog` events to renderer |
