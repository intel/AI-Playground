# Plan: Demo Mode Profile Descriptor

## Problem

The demo mode has 6 hardcoded identity points scattered across 3 files that tie it to a single "trade show" configuration. To support product variants like "essentials" mode, these need to be externalized into a per-profile config file.

### Current Hardcoded Identity Points

| What                          | Where                                      | Current Value                                    |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Default chat preset name      | `demoModeDefaults.ts` line 8               | `'Vision'`                                       |
| Default chat model            | `demoModeDefaults.ts` line 9               | `'unsloth/Qwen3-VL-4B-...'`                      |
| Default imageGen preset       | `demoModeDefaults.ts` line 10              | `'Pro Image'`                                    |
| Default imageEdit preset      | `demoModeDefaults.ts` line 11              | `'Edit by Prompt 2'`                             |
| Demo input image              | `demoModeDefaults.ts` line 6               | `dog_with_people.jpg` (static import)            |
| Sample prompts                | `DemoSamplePrompts.vue` lines 38-64        | 4 inline objects (chat/imageGen/imageEdit/video) |
| Tour step text                | `DemoModeOverlayDriverJs.vue` lines 27-117 | ~15 inline step definitions                      |
| Notification dot buttons      | `demoMode.ts` lines 15-24                  | `initiallyUnvisitedDemoButtonIds` array          |
| Video mode pre-marked visited | `demoMode.ts` line 31                      | `state['mode-button-video'] = true`              |

### What Already Works for Multi-Config (No Changes Needed)

- `demoModePresetsDir` in settings.json — already points to an arbitrary directory
- `reloadPresets` in electron/main.ts — already reads from that directory
- Per-preset `modifyable: false` / `defaultValue` overrides — already per-file
- `demoAwareStorage` — profile-agnostic sessionStorage isolation
- All DemoMode UI components (blocker, indicator, reset dialog) — read from store, not hardcoded

## Solution: `_profile.json` Descriptor

Each demo/essentials preset directory gets a `_profile.json` file that declares its identity. The electron main process loads and validates it via a **side-effect-free module** (`electron/demoProfile.ts`), then passes the parsed profile to the renderer via the existing `getDemoModeSettings` IPC channel.

### Profile Schema

```jsonc
// WebUI/external/presets_demo/_profile.json
{
  "defaults": {
    "chatPreset": "Vision",
    "chatModel": "unsloth/Qwen3-VL-4B-Instruct-GGUF/Qwen3-VL-4B-Instruct-Q5_K_S.gguf",
    "imageGenPreset": "Pro Image",
    "imageEditPreset": "Edit by Prompt 2",
  },
  "inputImage": "dog_with_people.jpg",
  "samplePrompts": [
    {
      "title": "Prompt Example",
      "description": "Ask a science question and get an answer:",
      "prompt": "Why does water expand when it freezes?",
      "mode": "chat",
    },
    {
      "title": "Image Generation Example",
      "description": "Create a fantastic image from a detailed prompt:",
      "prompt": "A close-up photo of a hummingbird hovering...",
      "mode": "imageGen",
    },
    {
      "title": "Image Editing Example",
      "description": "Edit a photo by describing what to change. An image is already given:",
      "prompt": "Remove people from the background",
      "mode": "imageEdit",
    },
    {
      "title": "Video Generation Example",
      "description": "Create a short video from a text description.",
      "prompt": "A golden retriever running through a field of sunflowers on a sunny day",
      "mode": "video",
    },
  ],
  "enabledModes": ["chat", "imageGen", "imageEdit", "video"],
  "notificationDotButtons": [
    "mode-button-chat",
    "mode-button-imageGen",
    "mode-button-imageEdit",
    "camera-button",
    "microphone-button",
    "app-settings-button",
    "advanced-settings-button",
    "plus-icon",
  ],
}
```

Notes on what's NOT in the profile:

- **Tour steps**: These reference DOM selectors and contain lengthy prose tightly coupled to the UI layout. Moving them to JSON would be brittle (no way to validate selectors at parse time) and the text is generic enough to work across profiles. Instead, the tour steps stay in the Vue component but are filtered by `enabledModes` — steps referencing disabled modes are skipped.
- **Tour text overrides**: If a future profile genuinely needs different tour text, a `tourOverrides` key can be added later. YAGNI for now.

### Input Image Resolution (Concrete Mechanism)

**Decision: Electron reads the image file from the presets directory and returns a `data:image/*;base64,...` URI in the IPC response.**

Rationale:

- The current flow already converts images to data URIs via `imageUrlToDataUri()` in `preloadImageDuringDemo()`. Data URIs are the native currency of ComfyUI image inputs.
- The `aipg-media` protocol only serves from `mediaDir` (line 1448 of `main.ts`). Extending it to also serve from presets dirs would add protocol routing complexity for a single use case.
- `file://` URLs are blocked by Electron's content security policy in the renderer.
- Electron already knows the absolute filesystem path to the presets directory. Reading a single image file and base64-encoding it is trivial (~50ms for a typical JPEG).

**Implementation**: In `loadDemoProfile()`, if `inputImage` is non-null, read the file from the presets directory, detect MIME type from extension, and embed as `data:image/{ext};base64,{data}`. The returned `DemoProfile` object's `inputImage` field becomes the full data URI (or `null`). The renderer never needs to resolve filesystem paths.

### Essentials Example

```jsonc
// WebUI/external/presets_essentials/_profile.json
{
  "defaults": {
    "chatPreset": "Basic",
    "chatModel": "unsloth/SmolLM2-1.7B-...",
    // no imageGenPreset, imageEditPreset — modes not enabled
  },
  "inputImage": null,
  "samplePrompts": [
    {
      "title": "Chat Example",
      "description": "Ask anything:",
      "prompt": "What is machine learning?",
      "mode": "chat",
    },
  ],
  "enabledModes": ["chat"],
  "notificationDotButtons": ["mode-button-chat", "app-settings-button", "plus-icon"],
}
```

## Implementation Steps

### Step 1: Create `electron/demoProfile.ts` — schema + loader (side-effect-free)

**New file: `WebUI/electron/demoProfile.ts`**

This module is intentionally side-effect-free so it can be imported in Vitest without triggering Electron's `app.whenReady()`, window creation, or protocol registration.

Contents:

```ts
import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SamplePromptSchema = z.object({
  title: z.string(),
  description: z.string(),
  prompt: z.string(),
  mode: z.enum(['chat', 'imageGen', 'imageEdit', 'video']),
})

export const DemoProfileSchema = z.object({
  defaults: z.object({
    chatPreset: z.string(),
    chatModel: z.string(),
    imageGenPreset: z.string().optional(),
    imageEditPreset: z.string().optional(),
  }),
  inputImage: z.string().nullable().default(null),
  samplePrompts: z.array(SamplePromptSchema).default([]),
  enabledModes: z
    .array(z.enum(['chat', 'imageGen', 'imageEdit', 'video']))
    .default(['chat', 'imageGen', 'imageEdit', 'video']),
  notificationDotButtons: z.array(z.string()).default([]),
})

export type DemoProfile = z.infer<typeof DemoProfileSchema>

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Loads and validates _profile.json from the given presets directory.
 * If `inputImage` is specified, reads the file and converts to a data URI.
 * Returns null if the file doesn't exist (logs a warning).
 * Throws on malformed JSON or schema validation failure.
 */
export function loadDemoProfile(
  presetsDir: string,
  logger?: { warn: (msg: string, tag: string) => void },
): DemoProfile | null {
  const profilePath = path.join(presetsDir, '_profile.json')

  if (!fs.existsSync(profilePath)) {
    logger?.warn(`Demo mode enabled but no _profile.json found at ${profilePath}`, 'demo-profile')
    return null
  }

  const raw = JSON.parse(fs.readFileSync(profilePath, 'utf-8'))
  const profile = DemoProfileSchema.parse(raw)

  // Resolve inputImage to data URI
  if (profile.inputImage) {
    const imagePath = path.join(presetsDir, profile.inputImage)
    if (!fs.existsSync(imagePath)) {
      throw new Error(
        `Demo profile references inputImage "${profile.inputImage}" but file not found at ${imagePath}`,
      )
    }
    const ext = path.extname(imagePath).toLowerCase()
    const mime = MIME_TYPES[ext]
    if (!mime) {
      throw new Error(
        `Demo profile inputImage "${profile.inputImage}" has unsupported extension "${ext}"`,
      )
    }
    const data = fs.readFileSync(imagePath)
    profile.inputImage = `data:${mime};base64,${data.toString('base64')}`
  }

  return profile
}
```

**QA**:

1. `npx vitest run electron/test/demoProfile.test.ts` → all tests pass (created in Step 2)
2. `npx vue-tsc --noEmit` → exit 0 (no type errors)
3. LSP diagnostics clean on `electron/demoProfile.ts`

### Step 2: Unit tests for schema + loader

**New file: `WebUI/electron/test/demoProfile.test.ts`**

Tests (all use Vitest, `describe`/`it`/`expect`):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DemoProfileSchema, loadDemoProfile } from '../demoProfile'

describe('DemoProfileSchema', () => {
  it('parses a fully-specified profile', () => {
    const input = {
      defaults: {
        chatPreset: 'Vision',
        chatModel: 'some/model.gguf',
        imageGenPreset: 'Pro Image',
        imageEditPreset: 'Edit by Prompt 2',
      },
      inputImage: 'dog.jpg',
      samplePrompts: [{ title: 'T', description: 'D', prompt: 'P', mode: 'chat' }],
      enabledModes: ['chat', 'imageGen'],
      notificationDotButtons: ['mode-button-chat'],
    }
    const result = DemoProfileSchema.parse(input)
    expect(result.defaults.chatPreset).toBe('Vision')
    expect(result.enabledModes).toEqual(['chat', 'imageGen'])
  })

  it('applies defaults for optional fields', () => {
    const input = {
      defaults: { chatPreset: 'A', chatModel: 'B' },
    }
    const result = DemoProfileSchema.parse(input)
    expect(result.inputImage).toBeNull()
    expect(result.samplePrompts).toEqual([])
    expect(result.enabledModes).toEqual(['chat', 'imageGen', 'imageEdit', 'video'])
    expect(result.notificationDotButtons).toEqual([])
  })

  it('rejects missing required fields', () => {
    expect(() => DemoProfileSchema.parse({})).toThrow()
    expect(() => DemoProfileSchema.parse({ defaults: {} })).toThrow()
  })

  it('rejects invalid mode values', () => {
    const input = {
      defaults: { chatPreset: 'A', chatModel: 'B' },
      enabledModes: ['chat', 'invalidMode'],
    }
    expect(() => DemoProfileSchema.parse(input)).toThrow()
  })
})

describe('loadDemoProfile', () => {
  // Uses real fs with temp dir — no mocks needed for file I/O
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'demo-profile-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when _profile.json does not exist', () => {
    const logger = { warn: vi.fn() }
    const result = loadDemoProfile(tmpDir, logger)
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('parses a valid _profile.json', () => {
    const profile = {
      defaults: { chatPreset: 'X', chatModel: 'Y' },
      samplePrompts: [],
    }
    fs.writeFileSync(path.join(tmpDir, '_profile.json'), JSON.stringify(profile))
    const result = loadDemoProfile(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.defaults.chatPreset).toBe('X')
    expect(result!.inputImage).toBeNull()
  })

  it('resolves inputImage to a data URI', () => {
    // Create a tiny 1x1 red PNG (valid PNG header + data)
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64',
    )
    fs.writeFileSync(path.join(tmpDir, 'test.png'), pngBuffer)

    const profile = {
      defaults: { chatPreset: 'X', chatModel: 'Y' },
      inputImage: 'test.png',
    }
    fs.writeFileSync(path.join(tmpDir, '_profile.json'), JSON.stringify(profile))

    const result = loadDemoProfile(tmpDir)
    expect(result!.inputImage).toMatch(/^data:image\/png;base64,/)
  })

  it('throws when inputImage references a missing file', () => {
    const profile = {
      defaults: { chatPreset: 'X', chatModel: 'Y' },
      inputImage: 'nonexistent.jpg',
    }
    fs.writeFileSync(path.join(tmpDir, '_profile.json'), JSON.stringify(profile))
    expect(() => loadDemoProfile(tmpDir)).toThrow(/not found/)
  })

  it('throws on malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '_profile.json'), '{bad json')
    expect(() => loadDemoProfile(tmpDir)).toThrow()
  })

  it('throws on schema validation failure', () => {
    fs.writeFileSync(path.join(tmpDir, '_profile.json'), JSON.stringify({ wrong: true }))
    expect(() => loadDemoProfile(tmpDir)).toThrow()
  })
})
```

**QA**:

1. `npx vitest run electron/test/demoProfile.test.ts` → 10 tests pass, exit 0
2. LSP diagnostics clean on test file

### Step 3: Wire loader into `electron/main.ts` and extend IPC

**File: `WebUI/electron/main.ts`**

Changes:

- Import `loadDemoProfile` and `DemoProfile` from `./demoProfile`
- Add module-level `let demoProfile: DemoProfile | null = null`
- At the end of `loadSettings()` (after `settings` is parsed, before the `return`), if `settings.isDemoModeEnabled`, resolve the presets dir and call `loadDemoProfile()`:
  ```ts
  if (settings.isDemoModeEnabled) {
    const presetsDir = settings.demoModePresetsDir
      ? path.resolve(settings.demoModePresetsDir)
      : path.join(
          app.isPackaged
            ? path.join(process.resourcesPath, 'presets_demo')
            : path.join(__dirname, '../../external/presets_demo'),
        )
    try {
      demoProfile = loadDemoProfile(presetsDir, appLogger)
    } catch (e) {
      appLogger.error(`Failed to load demo profile: ${e}`, 'demo-profile')
    }
  }
  ```
- Extend the `getDemoModeSettings` IPC handler:
  ```ts
  ipcMain.handle('getDemoModeSettings', () => {
    return {
      isDemoModeEnabled: settings.isDemoModeEnabled,
      demoModeResetInSeconds: settings.demoModeResetInSeconds,
      demoModePasscode: settings.demoModePasscode,
      profile: demoProfile,
    }
  })
  ```

**File: `WebUI/src/env.d.ts`**

Add `DemoProfile` type and extend `DemoModeSettings`:

```ts
type SamplePrompt = {
  title: string
  description: string
  prompt: string
  mode: ModeType
}

type DemoProfile = {
  defaults: {
    chatPreset: string
    chatModel: string
    imageGenPreset?: string
    imageEditPreset?: string
  }
  inputImage: string | null
  samplePrompts: SamplePrompt[]
  enabledModes: ModeType[]
  notificationDotButtons: string[]
}

type DemoModeSettings = {
  isDemoModeEnabled: boolean
  demoModeResetInSeconds: null | number
  demoModePasscode?: string
  profile?: DemoProfile | null
}
```

**File: `WebUI/electron/preload.ts`** — No changes needed (transparent passthrough).

**QA**:

1. `npx vue-tsc --noEmit` → exit 0
2. LSP diagnostics clean on `electron/main.ts` and `src/env.d.ts`
3. `npx vitest run` → all existing tests still pass (no regressions)

### Step 4: Expose profile in `demoMode` Pinia store

**File: `WebUI/src/assets/js/store/demoMode.ts`**

Changes:

- Add `const profile = ref<DemoProfile | null>(null)`
- In the `.then()` callback of `getDemoModeSettings()`: `profile.value = res.profile ?? null`
- Replace `initiallyUnvisitedDemoButtonIds` with a computed that reads from `profile.value?.notificationDotButtons`, falling back to the current hardcoded array when profile is null.
- Replace `createInitialVisitedState()` to derive pre-visited buttons from `enabledModes` — any `mode-button-*` id whose mode is NOT in `profile.value?.enabledModes` gets `state[id] = true` (pre-marked visited so no dot shows). Fallback: current hardcoded logic when profile is null.
- Export `profile` from the store return.

**QA**:

1. LSP diagnostics clean on `demoMode.ts`
2. `npx vue-tsc --noEmit` → exit 0

### Step 5: Replace hardcoded constants in `demoModeDefaults.ts`

**File: `WebUI/src/assets/js/store/demoModeDefaults.ts`**

Changes:

- **Keep** `DEMO_CHAT_PRESET`, `DEMO_CHAT_MODEL`, `DEMO_IMAGEGEN_PRESET`, `DEMO_IMAGEEDIT_PRESET` constants and the `demoInputImageUrl` import as **fallback values**. These ensure backward compatibility when no `_profile.json` exists (existing deployments without the file continue to work identically).
- `applyDemoModeExplicitDefaults()` reads from `useDemoMode().profile.defaults` when profile is available, otherwise falls back to the existing `DEMO_*` constants:
  ```ts
  const profile = useDemoMode().profile
  const chatPreset = profile?.defaults.chatPreset ?? DEMO_CHAT_PRESET
  const chatModel = profile?.defaults.chatModel ?? DEMO_CHAT_MODEL
  const imageGenPreset = profile?.defaults.imageGenPreset ?? DEMO_IMAGEGEN_PRESET
  const imageEditPreset = profile?.defaults.imageEditPreset ?? DEMO_IMAGEEDIT_PRESET
  // ... use these variables in place of the old constants
  ```
- `getDemoModeInputImage()` returns `useDemoMode().profile?.inputImage ?? demoInputImageUrl`. When profile is present, `loadDemoProfile()` has already converted the file to a data URI — no filesystem access needed in the renderer. When profile is absent, the existing static Vite import (`demoInputImageUrl`) is used as before. The existing `preloadImageDuringDemo()` in `imageGenerationPresets.ts` calls `imageUrlToDataUri()` on the result, but data URIs pass through `imageUrlToDataUri()` unchanged (it checks for `data:` prefix), so no change needed there.
- `populateImageEditHistory()` — no change, it already calls `getDemoModeInputImage()`.

Note: `dog_with_people.jpg` stays in `src/assets/image/` as the fallback. It should also be **copied** into `external/presets_demo/` so `_profile.json` can reference it. (Step 8 handles this.)

**QA**:

1. LSP diagnostics clean on `demoModeDefaults.ts`
2. `npx vue-tsc --noEmit` → exit 0
3. Verify `imageUrlToDataUri()` handles data URIs: grep for its implementation, confirm it short-circuits on `data:` prefix. If NOT, add a guard.

### Step 6: Replace inline sample prompts in `DemoSamplePrompts.vue`

**File: `WebUI/src/components/DemoSamplePrompts.vue`**

Changes:

- **Keep** the inline `samples` array as a fallback constant (renamed to `FALLBACK_SAMPLES`).
- Import `useDemoMode`
- Compute active sample from profile with fallback:
  ```ts
  const demoMode = useDemoMode()
  const samples = computed(() => demoMode.profile?.samplePrompts ?? FALLBACK_SAMPLES)
  const activeSample = computed(() => samples.value.find((s) => s.mode === promptStore.currentMode))
  ```
- Template: guard on `activeSample` presence (if no sample for current mode, render nothing — same as current behavior).

**QA**:

1. LSP diagnostics clean on `DemoSamplePrompts.vue`
2. `npx vue-tsc --noEmit` → exit 0

### Step 7: Filter tour steps and notification dots by `enabledModes`

**File: `WebUI/src/components/DemoModeOverlayDriverJs.vue`**

Changes:

- Tour step definitions stay inline (DOM-coupled).
- Import `useDemoMode`
- When building the driver steps array, filter out steps whose `element` selector maps to a disabled mode. Mapping:
  - `#mode-button-chat` → `chat`
  - `#mode-button-imageGen` → `imageGen`
  - `#mode-button-imageEdit` → `imageEdit`
  - `#mode-button-video` → `video`
  - All other selectors → always included
- Create a `modeForSelector` lookup map and filter: `steps.filter(s => !modeForSelector[s.element] || enabledModes.includes(modeForSelector[s.element]))`

**File: `WebUI/src/components/DemoModeNotificationDots.vue`**

Changes:

- Replace `initiallyUnvisitedDemoButtonIds` iteration with `demoMode.notificationDotButtonIds` (the computed from Step 4 that reads from profile or falls back to hardcoded).

**File: `WebUI/src/assets/js/store/demoMode.ts`** (already modified in Step 4)

- `createInitialVisitedState()`: instead of hardcoding `state['mode-button-video'] = true`, compute which mode buttons to pre-visit from `enabledModes`. Any `mode-button-*` NOT in `enabledModes` → `state[id] = true`.

**QA**:

1. LSP diagnostics clean on all 3 files
2. `npx vue-tsc --noEmit` → exit 0

### Step 8: Create `_profile.json` for existing demo presets + copy input image

**File: `WebUI/external/presets_demo/_profile.json`** (NEW)

```json
{
  "defaults": {
    "chatPreset": "Vision",
    "chatModel": "unsloth/Qwen3-VL-4B-Instruct-GGUF/Qwen3-VL-4B-Instruct-Q5_K_S.gguf",
    "imageGenPreset": "Pro Image",
    "imageEditPreset": "Edit by Prompt 2"
  },
  "inputImage": "dog_with_people.jpg",
  "samplePrompts": [
    {
      "title": "Prompt Example",
      "description": "Ask a science question and get an answer:",
      "prompt": "Why does water expand when it freezes?",
      "mode": "chat"
    },
    {
      "title": "Image Generation Example",
      "description": "Create a fantastic image from a detailed prompt:",
      "prompt": "A close-up photo of a hummingbird hovering to get nectar from a red rose with drops of dew. Iridescent blue and green feathers, wings a blur. Depth of field. High Dynamic Range.",
      "mode": "imageGen"
    },
    {
      "title": "Image Editing Example",
      "description": "Edit a photo by describing what to change. An image is already given:",
      "prompt": "Remove people from the background",
      "mode": "imageEdit"
    },
    {
      "title": "Video Generation Example",
      "description": "Create a short video from a text description.",
      "prompt": "A golden retriever running through a field of sunflowers on a sunny day",
      "mode": "video"
    }
  ],
  "enabledModes": ["chat", "imageGen", "imageEdit", "video"],
  "notificationDotButtons": [
    "mode-button-chat",
    "mode-button-imageGen",
    "mode-button-imageEdit",
    "camera-button",
    "microphone-button",
    "app-settings-button",
    "advanced-settings-button",
    "plus-icon"
  ]
}
```

**Copy image**: `cp WebUI/src/assets/image/dog_with_people.jpg WebUI/external/presets_demo/dog_with_people.jpg`

The image now lives in the presets directory alongside `_profile.json`, so `loadDemoProfile()` can find it. The copy in `src/assets/image/` is NOT removed (it may have other uses, and removing it is a separate cleanup).

**QA**:

1. `npx vitest run electron/test/demoProfile.test.ts` → still passes
2. Validate JSON: `node -e "JSON.parse(require('fs').readFileSync('external/presets_demo/_profile.json', 'utf8'))"` → no error
3. Verify image exists: `ls -la external/presets_demo/dog_with_people.jpg` → file present

### Step 9: Update `info.md` documentation

**File: `WebUI/external/presets_demo/info.md`**

Add a section documenting `_profile.json`:

- What each field does
- How to create a new profile for a different product variant
- That `inputImage` is relative to the presets dir and gets embedded as a data URI
- That `enabledModes` controls tour step filtering and notification dot visibility

**QA**:

1. Read `external/presets_demo/info.md` and confirm it contains a `_profile.json` section that documents:
   - Each field's purpose (`defaults`, `inputImage`, `samplePrompts`, `enabledModes`, `notificationDotButtons`)
   - That `inputImage` is a filename relative to the presets dir and gets embedded as a data URI by electron
   - That `enabledModes` controls tour step filtering and notification dot visibility
   - How to create a new profile for a different product variant

### Step 10: Verify build packaging

**File: `WebUI/build/build-config.json`**

Check that the existing `"from": "external/presets_demo", "to": "presets_demo"` mapping copies ALL files (not just `*.json`). If it's a directory copy, `_profile.json` and `dog_with_people.jpg` are included automatically. Verify by reading the config.

**QA**:

1. Read `build/build-config.json` and confirm presets_demo copy is a full directory copy
2. If selective, add `_profile.json` and `dog_with_people.jpg` explicitly

### Step 11: Full verification pass

Run all checks in sequence:

1. `npx vitest run` → all tests pass (exit 0). Expected: existing tests + new `demoProfile.test.ts` all green.
2. `npx vue-tsc --noEmit` → exit 0. Expected: no type errors across the project.
3. `npm run lint:ci` → exit 0. Expected: no lint errors.
4. `npm run format:ci` → exit 0. Expected: no formatting issues.

If any check fails, fix the issue and re-run.

## File Change Summary

| File                                          | Change Type | Description                                                                             |
| --------------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `electron/demoProfile.ts`                     | **Create**  | Zod schema + `loadDemoProfile()` loader (side-effect-free, testable)                    |
| `electron/test/demoProfile.test.ts`           | **Create**  | Unit tests for schema validation + loader behavior (10 test cases)                      |
| `electron/main.ts`                            | Modify      | Import + call `loadDemoProfile()` in `loadSettings()`, extend `getDemoModeSettings` IPC |
| `src/env.d.ts`                                | Modify      | Add `DemoProfile`, `SamplePrompt` types; extend `DemoModeSettings`                      |
| `src/assets/js/store/demoMode.ts`             | Modify      | Add `profile` ref, derive notification dots + visited state from profile                |
| `src/assets/js/store/demoModeDefaults.ts`     | Modify      | Replace 4 constants + static image import with profile reads                            |
| `src/components/DemoSamplePrompts.vue`        | Modify      | Read prompts from profile instead of inline array                                       |
| `src/components/DemoModeOverlayDriverJs.vue`  | Modify      | Filter tour steps by `enabledModes`                                                     |
| `src/components/DemoModeNotificationDots.vue` | Modify      | Iterate profile's dot buttons instead of hardcoded array                                |
| `external/presets_demo/_profile.json`         | **Create**  | Profile descriptor for existing demo config                                             |
| `external/presets_demo/dog_with_people.jpg`   | **Create**  | Copy of input image into presets dir (for profile resolution)                           |
| `external/presets_demo/info.md`               | Modify      | Document `_profile.json` usage                                                          |
| `build/build-config.json`                     | Verify      | Ensure `_profile.json` + image are packaged                                             |

## Backward Compatibility

Every consumer falls back to current hardcoded behavior when `profile` is `null` (no `_profile.json` found). Specifically:

- `demoModeDefaults.ts` retains the `DEMO_*` constants and `demoInputImageUrl` import as fallbacks. When `profile` is null, these are used — behavior is identical to today.
- `demoMode.ts` falls back to the hardcoded `initiallyUnvisitedDemoButtonIds` array and current `createInitialVisitedState()` logic when profile is null.
- `DemoSamplePrompts.vue` falls back to the existing inline samples array (renamed `FALLBACK_SAMPLES`) when profile is null — behavior identical to today.
- `DemoModeOverlayDriverJs.vue` shows all tour steps when profile is null (no filtering applied).
- Existing `presets_demo/` directory works without `_profile.json` (but logs a warning)
- No breaking change for anyone not using the new feature
- The `_profile.json` we ship makes behavior identical to today

## Open Questions

1. **Should `enabledModes` hide mode buttons entirely, or just skip tour/dots?** Hiding buttons is a bigger UI change (affects `PromptArea.vue` mode button rendering). For now the plan only filters tour steps and notification dots — mode buttons remain visible but have no preset/sample behind them.

## Risk Assessment

- **Low risk**: Steps 1-3, 8-10 (schema, IPC plumbing, JSON file creation) — mechanical changes
- **Medium risk**: Steps 4-7 (replacing hardcoded values with profile reads) — need careful testing that the timing of profile availability in the store matches when consumers read it
- **Key timing concern**: `applyDemoModeExplicitDefaults()` runs after a 1s delay. The profile must be loaded by then. Since it comes from `getDemoModeSettings()` which is already awaited at app startup (`src/main.ts`), and the store's `.then()` runs before the 1s delay in `applyExplicitDefaults()`, this should be safe. But worth verifying.
