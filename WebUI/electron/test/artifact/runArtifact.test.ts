import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, ref } from 'vue'
import type { MediaItem } from '@/assets/js/store/imageGenerationPresets'
import type { ComfyInput, Preset, Setting } from '@/assets/js/store/presets'
import type { ArtifactRequest } from '@/assets/js/artifact/runArtifact'

// The artifact client is tested against hand-driven store mocks: only its own
// contract matters here — request → resolved payload (params, variant,
// inputs, items) shipped over the artifact:run IPC, and how the main-process
// runner's result settles back onto the caller. The engine itself lives in
// main (electron/artifact/runner.ts) and has its own suite against a fake
// ComfyUI; here the IPC seam is the fake.

const generatedImages = ref<MediaItem[]>([])
const comfyInputsPerPreset = ref<Record<string, Record<string, unknown>>>({})
const lastError = ref<string | null>(null)
const parentActivityId = ref<string | null>(null)
const presetsFixture = ref<Preset[]>([])
const activeVariantName = ref<Record<string, string>>({})

const runIpcMock = vi.fn<(payload: unknown) => Promise<unknown>>()
const cancelIpcMock = vi.fn<(runId?: string) => Promise<void>>()
const ensureModelsMock = vi.fn<(preset: unknown) => Promise<void>>()
const failGenerationMock = vi.fn<(message: string) => void>()
const resolvePresetVariantMock = vi.fn<(name: string, variant?: string | null) => Preset | null>()
const imageUrlToDataUriMock = vi.fn<(source: string) => Promise<string>>()

// Mirrors the real pure helper the client imports (the module itself is mocked
// below because its store half drags the whole renderer graph with it).
vi.mock('@/assets/js/store/imageGenerationPresets', () => ({
  OPTIONAL_MODEL_NONE: 'None',
  presetSettingsKey: (presetName: string, variant?: string | null) =>
    variant ? `${presetName}:${variant}` : presetName,
  useImageGenerationPresets: () => ({
    get generatedImages() {
      return generatedImages.value
    },
    set generatedImages(value: MediaItem[]) {
      generatedImages.value = value
    },
    get comfyInputsPerPreset() {
      return comfyInputsPerPreset.value
    },
    get lastError() {
      return lastError.value
    },
    set lastError(value: string | null) {
      lastError.value = value
    },
    get generationParentActivityId() {
      return parentActivityId.value
    },
    set generationParentActivityId(value: string | null) {
      parentActivityId.value = value
    },
    get safetyCheck() {
      return true
    },
    get showPreview() {
      return false
    },
    updateImage: (item: MediaItem) => {
      const list = generatedImages.value
      const idx = list.findIndex((img) => img.id === item.id)
      if (idx === -1) {
        generatedImages.value = [...list, item]
      } else {
        const copy = [...list]
        copy[idx] = item
        generatedImages.value = copy
      }
    },
    failGeneration: failGenerationMock,
    ensureModelsAreAvailableFor: ensureModelsMock,
    trackArtifactRun: vi.fn(),
    untrackArtifactRun: vi.fn(),
  }),
}))

vi.mock('@/assets/js/store/developerSettings', () => ({
  useDeveloperSettings: () => ({ keepModelsLoaded: false }),
}))

vi.mock('@/assets/js/store/presets', () => ({
  // Real value — the (unmocked) presetModes module imports this constant.
  AUDIO_CATEGORY: 'audio',
  usePresets: () => ({
    get presets() {
      return presetsFixture.value
    },
    get activeVariantName() {
      return activeVariantName.value
    },
    getFirstVariantName: (preset: Preset) => preset.variants?.[0]?.name ?? null,
    resolvePresetVariant: resolvePresetVariantMock,
  }),
}))

vi.mock('@/lib/utils', () => ({
  imageUrlToDataUri: imageUrlToDataUriMock,
}))

// The IPC seam. window does not exist in the node test environment; the client
// reads it lazily at submit time, never at import time.
vi.stubGlobal('window', {
  electronAPI: {
    artifact: {
      run: runIpcMock,
      cancel: cancelIpcMock,
    },
  },
})

const { runArtifact, artifactKindForMedia } = await import('@/assets/js/artifact/runArtifact')
const { createAppError } = await import('@/assets/js/errors/appError')

type RunPayload = {
  runId: string
  mode: string
  preset: Preset
  params: Record<string, unknown>
  inputs: Array<Record<string, unknown> & { current: unknown }>
  items: MediaItem[]
  source?: string
  variant?: string
  origin?: 'renderer' | 'agent'
  modelsConsented: boolean
  keepModelsLoaded: boolean
}

type IpcResult = { state: 'completed' | 'failed' | 'cancelled'; items: MediaItem[]; error?: string }

type ComfyFixture = Preset & {
  type: 'comfy'
  backend: 'comfyui'
}

function comfyPreset(overrides: Partial<ComfyFixture> & { name: string }): ComfyFixture {
  return {
    type: 'comfy',
    backend: 'comfyui',
    category: 'create-images',
    settings: [],
    description: '',
    ...overrides,
  } as unknown as ComfyFixture
}

/** Wire the presets-store mock the way the real store resolves variants. */
function applyVariantForReal(name: string, variant?: string | null): Preset | null {
  const preset = presetsFixture.value.find((p) => p.name === name)
  if (!preset) return null
  if (!variant || !preset.variants?.some((v) => v.name === variant)) return preset
  const overrides = preset.variants.find((v) => v.name === variant)?.overrides
  return { ...preset, ...overrides }
}

function standardSetting(settingName: string, defaultValue: unknown): Setting {
  return {
    type: 'number',
    label: settingName,
    displayed: true,
    modifiable: true,
    settingName,
    defaultValue,
  } as unknown as Setting
}

function imageInputFixture(): ComfyInput {
  return {
    type: 'image',
    label: 'Source',
    nodeTitle: 'LoadImage',
    nodeInput: 'image',
    displayed: true,
    modifiable: true,
    defaultValue: '',
  } as unknown as ComfyInput
}

/** The happy path: main reports every batch entry done. */
function resolveCompleted(): IpcResult {
  const payload = runIpcMock.mock.calls[0][0] as RunPayload
  return {
    state: 'completed',
    items: payload.items.map((item) => ({
      ...item,
      type: 'image',
      state: 'done',
      imageUrl: `aipg-media://${item.id}.png`,
    })),
  }
}

/**
 * Start a run and wait until it has been shipped to main. The pending promise
 * rides in a box: an async function returning it directly would adopt it, so
 * `await startAndAwaitSubmit(...)` would wait for the run itself — which only
 * the caller's next line can settle.
 */
async function startAndAwaitSubmit(request: ArtifactRequest) {
  const pending = runArtifact(request)
  await vi.waitFor(() => expect(runIpcMock).toHaveBeenCalled())
  return { result: pending }
}

describe('runArtifact', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    generatedImages.value = []
    comfyInputsPerPreset.value = {}
    lastError.value = null
    parentActivityId.value = null
    activeVariantName.value = {}
    runIpcMock.mockReset().mockImplementation(async (payload) => {
      // Electron ipcRenderer.invoke structured-clones; a Vue proxy must not survive here.
      structuredClone(payload)
      return resolveCompleted()
    })
    cancelIpcMock.mockReset().mockResolvedValue()
    ensureModelsMock.mockReset().mockResolvedValue()
    failGenerationMock.mockReset().mockImplementation((message: string) => {
      // Mirrors the real store: the failed panel reads this.
      lastError.value = message
      generatedImages.value = generatedImages.value.map((img) =>
        img.state === 'queued' || img.state === 'generating'
          ? ({ ...img, state: 'failed' as const } as MediaItem)
          : img,
      )
    })
    imageUrlToDataUriMock.mockReset().mockImplementation(async (source: string) => source)
    resolvePresetVariantMock.mockReset().mockImplementation(applyVariantForReal)
  })

  it('falls back to the global constants when the request and preset are silent', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    expect((await result).state).toBe('completed')

    const payload = runIpcMock.mock.calls[0][0] as RunPayload
    expect(payload.params).toMatchObject({
      prompt: 'a castle',
      negativePrompt: 'nsfw',
      seed: -1,
      inferenceSteps: 6,
      width: 512,
      height: 512,
      batchSize: 1,
    })
  })

  it('prefers request values over preset defaults over the fallback constants', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Draft Image',
        settings: [
          standardSetting('inferenceSteps', 30),
          standardSetting('negativePrompt', 'blurry'),
          standardSetting('seed', 7),
          standardSetting('resolution', '1024x768'),
          standardSetting('batchSize', 4),
        ],
      }),
    ]

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
      negativePrompt: 'custom',
      params: { seed: 42, inferenceSteps: 12, batchSize: 2 },
    })
    await result

    const payload = runIpcMock.mock.calls[0][0] as RunPayload
    // Request wins for what it named; preset defaults fill the rest.
    expect(payload.params).toMatchObject({
      prompt: 'a castle',
      negativePrompt: 'custom',
      seed: 42,
      inferenceSteps: 12,
      width: 1024,
      height: 768,
      batchSize: 2,
    })
    // Fixed seed + batch index → per-item seeds 42, 43.
    expect(payload.items.map((item) => item.settings.seed)).toEqual([42, 43])
  })

  it('forces batchSize 1 for video workflows regardless of the request', async () => {
    presetsFixture.value = [
      comfyPreset({ name: 'LTX Video', mediaType: 'video', category: 'create-videos' }),
    ]

    const { result } = await startAndAwaitSubmit({
      kind: 'create-video',
      workflow: 'LTX Video',
      prompt: 'a wave',
      params: { batchSize: 4 },
    })
    await result

    const payload = runIpcMock.mock.calls[0][0] as RunPayload
    expect(payload.params.batchSize).toBe(1)
  })

  it('fails fast on an unknown workflow without reaching main', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]

    const result = await runArtifact({
      kind: 'create-image',
      workflow: 'Nope',
      prompt: 'a castle',
    })

    expect(result).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('Unknown workflow'),
    })
    expect(runIpcMock).not.toHaveBeenCalled()
  })

  it('resolves the variant like a preset switch would, without switching', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Draft Image',
        variants: [
          { name: 'Standard', overrides: { description: 'standard variant' } },
          { name: 'Fast', overrides: {} },
        ],
      }),
    ]

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      variant: 'Bogus',
      prompt: 'a castle',
    })
    await result

    // Invalid requested variant falls back to the first, like getPresetWithVariant.
    expect(resolvePresetVariantMock).toHaveBeenCalledWith('Draft Image', 'Standard')
    const payload = runIpcMock.mock.calls[0][0] as RunPayload
    // The variant's overrides are merged in; the preset's own name is untouched.
    expect(payload.preset.name).toBe('Draft Image')
    expect(payload.preset.description).toBe('standard variant')
    expect(payload.variant).toBe('Standard')
    expect(payload.origin).toBe('renderer')
  })

  it('falls back to the remembered variant when the request names none', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Draft Image',
        variants: [
          { name: 'Standard', overrides: {} },
          { name: 'Fast', overrides: {} },
        ],
      }),
    ]
    activeVariantName.value = { 'Draft Image': 'Fast' }

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    await result

    expect(resolvePresetVariantMock).toHaveBeenCalledWith('Draft Image', 'Fast')
  })

  it('snapshots saved dynamic inputs and bypasses missing optional model inputs', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Draft Image',
        variants: [{ name: 'Fast', overrides: {} }],
        settings: [
          {
            type: 'model',
            label: 'LoRA',
            nodeTitle: 'LoraLoader',
            nodeInput: 'lora_name',
            displayed: true,
            modifiable: true,
            modelType: 'loras',
            optional: true,
          },
          {
            type: 'model',
            label: 'Checkpoint',
            nodeTitle: 'CheckpointLoaderSimple',
            nodeInput: 'ckpt_name',
            displayed: true,
            modifiable: true,
            modelType: 'checkpoints',
            optional: true,
          },
        ],
      }),
    ]
    comfyInputsPerPreset.value = {
      // Keyed with the variant applied, like the real settings sidebar does.
      'Draft Image:Fast': { 'LoraLoader.lora_name': 'my-lora.safetensors' },
    }

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    await result

    const payload = runIpcMock.mock.calls[0][0] as RunPayload
    const byTitle = (title: string) =>
      payload.inputs.find((input) => input.nodeTitle === title)!.current
    expect(byTitle('LoraLoader')).toBe('my-lora.safetensors')
    // Optional model input with no saved value → bypass marker.
    expect(byTitle('CheckpointLoaderSimple')).toBe('None')
  })

  it('injects the source image into the first required image input', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Edit By Prompt',
        category: 'edit-images',
        settings: [imageInputFixture()],
      }),
    ]
    imageUrlToDataUriMock.mockResolvedValue('data:image/png;base64,SOURCE')

    const { result } = await startAndAwaitSubmit({
      kind: 'edit-image',
      workflow: 'Edit By Prompt',
      prompt: 'make it blue',
      source: 'aipg-media://source.png',
    })
    await result

    expect(imageUrlToDataUriMock).toHaveBeenCalledWith('aipg-media://source.png')
    const payload = runIpcMock.mock.calls[0][0] as RunPayload
    expect(payload.inputs[0].current).toBe('data:image/png;base64,SOURCE')
    expect(payload.source).toBe('aipg-media://source.png')
    expect(payload.items[0].sourceImageUrl).toBe('aipg-media://source.png')
  })

  it('fails when an edit has no suitable image input', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Edit By Prompt',
        category: 'edit-images',
        settings: [{ ...imageInputFixture(), defaultValue: 'preset-default.png' }],
      }),
    ]

    const result = await runArtifact({
      kind: 'edit-image',
      workflow: 'Edit By Prompt',
      prompt: 'make it blue',
      source: 'aipg-media://source.png',
    })

    expect(result).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('No suitable image input'),
    })
    expect(runIpcMock).not.toHaveBeenCalled()
  })

  it('rethrows a cancelled model download instead of failing silently', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    ensureModelsMock.mockRejectedValue(
      createAppError({
        category: 'validation',
        code: 'user/cancelled',
        userMessage: 'Download cancelled',
      }),
    )

    await expect(
      runArtifact({ kind: 'create-image', workflow: 'Draft Image', prompt: 'a castle' }),
    ).rejects.toMatchObject({ code: 'user/cancelled' })
    expect(runIpcMock).not.toHaveBeenCalled()
  })

  it('marks the payload as consented and forwards the keep-models-loaded flag', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    await result

    // The renderer's pre-flight (permissions dialog) already ran, so main
    // must not ask again; the GPU-hold flag rides the payload.
    const payload = runIpcMock.mock.calls[0][0] as RunPayload
    expect(payload.modelsConsented).toBe(true)
    expect(payload.keepModelsLoaded).toBe(false)
  })

  it('removes the queued stubs and fails fast when main refuses a run', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    runIpcMock.mockResolvedValueOnce({
      state: 'failed',
      items: [],
      error: 'Another generation is already in progress',
    })

    const result = await runArtifact({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })

    expect(result).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('already in progress'),
    })
    expect(generatedImages.value).toEqual([])
  })

  it('drops the queued stubs when main fails the run before anything generated', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    runIpcMock.mockResolvedValueOnce({
      state: 'failed',
      items: [],
      error: 'The ComfyUI backend stopped unexpectedly',
    })

    const result = await runArtifact({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })

    expect(result.state).toBe('failed')
    // Nothing of this run is in flight — no permanent placeholders in history.
    expect(generatedImages.value).toEqual([])
  })

  it('keeps already-done items in the history when a later failure carries them', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Draft Image',
        settings: [standardSetting('batchSize', 2)],
      }),
    ]
    runIpcMock.mockImplementation(async () => {
      const payload = runIpcMock.mock.calls[0][0] as RunPayload
      return {
        state: 'failed',
        // First batch entry made it out before the run died.
        items: payload.items.slice(0, 1).map((item) => ({
          ...item,
          state: 'done',
          imageUrl: `aipg-media://${item.id}.png`,
        })),
        error: 'Workflow execution failed',
      }
    })

    const result = await runArtifact({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })

    expect(result.state).toBe('failed')
    expect(result.items).toHaveLength(1)
    // The failure reached main mid-run, so the stubs stay in history.
    expect(generatedImages.value).toHaveLength(2)
  })

  it('forwards the runner result untouched: failed carries the error', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    runIpcMock.mockResolvedValueOnce({
      state: 'failed',
      items: [],
      error: 'The ComfyUI backend could not generate the image.',
    })

    const result = await runArtifact({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })

    expect(result).toMatchObject({
      state: 'failed',
      error: 'The ComfyUI backend could not generate the image.',
    })
  })

  it('forwards the runner result untouched: cancelled', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    runIpcMock.mockResolvedValueOnce({ state: 'cancelled', items: [] })

    const result = await runArtifact({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })

    expect(result).toMatchObject({ state: 'cancelled' })
  })

  it('cancels the run by id and resolves cancelled when the caller aborts mid-run', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    let resolveRun!: (result: IpcResult) => void
    runIpcMock.mockImplementationOnce(
      () =>
        new Promise<IpcResult>((resolve) => {
          resolveRun = resolve
        }),
    )
    const controller = new AbortController()

    const pending = runArtifact(
      { kind: 'create-image', workflow: 'Draft Image', prompt: 'a castle' },
      { abortSignal: controller.signal },
    )
    await vi.waitFor(() => expect(runIpcMock).toHaveBeenCalled())
    controller.abort()
    resolveRun({ state: 'cancelled', items: [] })

    const result = await pending
    const payload = runIpcMock.mock.calls[0][0] as RunPayload
    expect(result).toMatchObject({ state: 'cancelled' })
    expect(cancelIpcMock).toHaveBeenCalledTimes(1)
    expect(cancelIpcMock).toHaveBeenCalledWith(payload.runId)
  })

  it('resolves cancelled without registering items when the signal fires while models prepare', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    let resolveModels!: () => void
    ensureModelsMock.mockImplementation(
      () => new Promise<void>((resolve) => (resolveModels = resolve)),
    )
    const controller = new AbortController()

    const pending = runArtifact(
      { kind: 'create-image', workflow: 'Draft Image', prompt: 'a castle' },
      { abortSignal: controller.signal },
    )
    controller.abort()
    resolveModels()

    const result = await pending
    expect(result).toMatchObject({ state: 'cancelled', items: [] })
    expect(runIpcMock).not.toHaveBeenCalled()
    expect(generatedImages.value).toEqual([])
    expect(cancelIpcMock).not.toHaveBeenCalled()
  })

  it('does not leak the injected source back into the persisted input map', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Edit By Prompt',
        category: 'edit-images',
        settings: [imageInputFixture()],
      }),
    ]
    comfyInputsPerPreset.value = { 'Edit By Prompt': { 'LoadImage.image': 'preset-default.png' } }
    imageUrlToDataUriMock.mockResolvedValue('data:image/png;base64,SOURCE')

    const { result } = await startAndAwaitSubmit({
      kind: 'edit-image',
      workflow: 'Edit By Prompt',
      prompt: 'make it blue',
      source: 'aipg-media://source.png',
    })
    await result

    const payload = runIpcMock.mock.calls[0][0] as RunPayload
    expect(payload.inputs[0].current).toBe('data:image/png;base64,SOURCE')
    expect(comfyInputsPerPreset.value['Edit By Prompt']['LoadImage.image']).toBe(
      'preset-default.png',
    )
  })

  it('ships a structured-cloneable payload, not the live Vue proxy', async () => {
    presetsFixture.value = [
      reactive(
        comfyPreset({
          name: 'Draft Image',
          settings: [standardSetting('inferenceSteps', 6)],
        }),
      ),
    ]
    comfyInputsPerPreset.value = reactive({
      'Draft Image': { 'KSampler.seed': 7 },
    })

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    expect((await result).state).toBe('completed')

    const payload = runIpcMock.mock.calls[0][0] as RunPayload
    expect(payload.preset.name).toBe('Draft Image')
    expect(payload.params.prompt).toBe('a castle')
  })

  it('settles the items locally when the IPC itself rejects', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    runIpcMock.mockRejectedValueOnce(new Error('socket closed'))

    const result = await runArtifact({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })

    expect(result).toMatchObject({ state: 'failed', error: 'socket closed' })
    expect(failGenerationMock).toHaveBeenCalledWith('socket closed')
  })

  it('buckets items by the requested mode, defaulting to the preset category', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Edit By Prompt', category: 'edit-images' })]

    const { result } = await startAndAwaitSubmit({
      kind: 'edit-image',
      workflow: 'Edit By Prompt',
      prompt: 'make it blue',
    })
    const settled = (await result) as IpcResult

    expect(settled.items.every((item) => item.mode === 'imageEdit')).toBe(true)
  })
})

describe('artifactKindForMedia', () => {
  it('maps media type and source onto the kind later adapters will key off', () => {
    expect(artifactKindForMedia('image', false)).toBe('create-image')
    expect(artifactKindForMedia('image', true)).toBe('edit-image')
    expect(artifactKindForMedia('video', false)).toBe('create-video')
    expect(artifactKindForMedia('video', true)).toBe('create-video')
    expect(artifactKindForMedia('model3d', false)).toBe('create-3d')
    expect(artifactKindForMedia(undefined, false)).toBe('create-image')
  })
})
