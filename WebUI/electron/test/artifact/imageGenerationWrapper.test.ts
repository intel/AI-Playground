import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'

// The SUT gets ref/computed from unplugin-auto-import (only `watch` is
// imported explicitly), but vitest.config.ts runs without that plugin —
// expose the two identifiers as globals, exactly what the plugin injects.
Object.assign(globalThis, { computed, ref })

// The store's kernel projection reads window.electronAPI at setup time; with
// an empty stub it no-ops, exactly like a renderer without the artifact IPC.
const cancelIpcMock = vi.fn<(runId?: string) => Promise<void>>().mockResolvedValue()
const kernelListeners: Array<(event: unknown) => void> = []
vi.stubGlobal('window', {
  electronAPI: {
    artifact: { cancel: cancelIpcMock },
    onKernelEvent: (cb: (event: unknown) => void) => {
      kernelListeners.push(cb)
      return () => {
        const index = kernelListeners.indexOf(cb)
        if (index >= 0) kernelListeners.splice(index, 1)
      }
    },
    getKernelSnapshot: async () => ({
      scope: { kind: 'global' },
      sequence: 0,
      state: {
        services: [],
        activeTurn: null,
        activeArtifactRun: null,
        chatTurns: [],
        activities: [],
        inferenceProfile: null,
      },
    }),
  },
})

// vi.mock factories are hoisted above every top-level const, so the shared
// proxy helper must live here.
function anyMemberStore() {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === 'symbol') return undefined
        // Calls on an unmodelled member resolve immediately; reads would be a
        // function (truthy), but no setup-level code reads these stores.
        return vi.fn().mockReturnValue(undefined)
      },
    },
  )
}
// The wrapper under test is the real imageGenerationPresets store; everything
// it touches is stubbed. Store mocks return plain objects (no pinia proxy), so
// members are the final values, never refs.
const runArtifactMock = vi.fn<(request: unknown, ctx?: unknown) => Promise<unknown>>()
const errorsReportMock = vi.fn()
const presetsFixture = ref<unknown[]>([])
const activePresetWithVariant = ref<unknown>(null)
const activeVariantName = ref<Record<string, string>>({})

vi.mock('@/assets/js/artifact/runArtifact', () => ({ runArtifact: runArtifactMock }))
vi.mock('@/assets/js/store/comfyUiPresets', () => ({ useComfyUiPresets: () => anyMemberStore() }))
vi.mock('@/assets/js/store/homeAgent', () => ({ useHomeAgent: () => anyMemberStore() }))
vi.mock('@/assets/js/store/dialogs', () => ({
  useDialogStore: () => anyMemberStore(),
  // The runner (mocked above) is the only real consumer; the SUT imports the
  // type only, but keep the runtime export present for safety.
  PresetRequirementsData: undefined,
}))
vi.mock('@/assets/js/store/ui', () => ({ useUIStore: () => anyMemberStore() }))
vi.mock('@/assets/js/store/backendServices', () => ({
  useBackendServices: () => anyMemberStore(),
}))
vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReportMock, recentErrors: [] }),
}))
vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ state: { COM_GENERATING: 'Generating' } }),
}))
vi.mock('@/assets/js/store/demoMode', () => ({
  // Plain false: a function (truthy) would flip the demo branches on.
  useDemoMode: () => ({ enabled: false }),
}))
vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    get presets() {
      return presetsFixture.value
    },
    get activePresetWithVariant() {
      return activePresetWithVariant.value
    },
    get activeVariantName() {
      return activeVariantName.value
    },
    getFirstVariantName: vi.fn(() => null),
  }),
  presetRequiresUserPrompt: vi.fn(() => false),
}))
vi.mock('@/assets/js/store/demoModeDefaults', () => ({
  getDemoModeInputImage: vi.fn(() => null),
  getDemoModeSketchInputImage: vi.fn(() => null),
  getDemoModeUpscaleInputImage: vi.fn(() => null),
}))
vi.mock('@/lib/utils', () => ({
  imageUrlToDataUri: vi.fn(async (source: string) => source),
  saveImageToMediaInput: vi.fn(async (dataUri: string) => dataUri),
}))
vi.mock('@/lib/laminarSpans', () => ({
  withTraceSpan: (_name: string, fn: () => unknown) => fn(),
}))
vi.mock('@/assets/js/imageGenerationUtils', () => ({
  getMissingComfyuiBackendModels: vi.fn(async () => []),
}))

// Imported late on purpose: a dynamic import runs in source order, so the
// hoisted factories only execute after the mock consts are initialized.
const { useImageGenerationPresets } = await import('@/assets/js/store/imageGenerationPresets')

const comfyPresetFixture = (overrides: Record<string, unknown> = {}) => ({
  name: 'Draft Image',
  type: 'comfy',
  category: 'create-images',
  backend: 'comfyui',
  mediaType: 'image',
  settings: [],
  requiredModels: [],
  ...overrides,
})

describe('imageGenerationPresets.generate (UI wrapper)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    kernelListeners.length = 0
    runArtifactMock.mockReset()
    errorsReportMock.mockReset()
    runArtifactMock.mockResolvedValue({ state: 'completed', items: [] })
    presetsFixture.value = []
    activeVariantName.value = {}
    activePresetWithVariant.value = null
  })

  it('maps each panel mode to its artifact kind and passes mode through', async () => {
    activePresetWithVariant.value = comfyPresetFixture()
    const store = useImageGenerationPresets()

    await store.generate('imageGen')
    await store.generate('imageEdit')
    await store.generate('video')

    const kinds = runArtifactMock.mock.calls.map(
      (call) => (call[0] as { kind: string; mode: string }).kind,
    )
    const modes = runArtifactMock.mock.calls.map(
      (call) => (call[0] as { kind: string; mode: string }).mode,
    )
    expect(kinds).toEqual(['create-image', 'edit-image', 'create-video'])
    expect(modes).toEqual(['imageGen', 'imageEdit', 'video'])
  })

  it('forwards form state and the active variant, and resolves with the runner result', async () => {
    activePresetWithVariant.value = comfyPresetFixture({ name: 'Draft Image' })
    activeVariantName.value = { 'Draft Image': 'Pencil' }
    const runnerResult = { state: 'completed', items: ['an-item'] }
    runArtifactMock.mockResolvedValueOnce(runnerResult)

    const store = useImageGenerationPresets()
    store.prompt = 'a castle'
    store.negativePrompt = 'blurry'
    store.seed = 42
    store.width = 1024
    store.height = 768
    store.inferenceSteps = 20
    store.batchSize = 1

    const result = await store.generate('imageGen')

    expect(runArtifactMock).toHaveBeenCalledTimes(1)
    expect(runArtifactMock.mock.calls[0][0]).toMatchObject({
      kind: 'create-image',
      workflow: 'Draft Image',
      variant: 'Pencil',
      prompt: 'a castle',
      negativePrompt: 'blurry',
      params: { seed: 42, width: 1024, height: 768, inferenceSteps: 20, batchSize: 1 },
    })
    expect(result).toBe(runnerResult)
  })

  it('never injects a generic source — panel sources ride the saved inputs', async () => {
    activePresetWithVariant.value = comfyPresetFixture({ category: 'edit-images' })
    const store = useImageGenerationPresets()

    await store.generate('imageEdit')

    expect(runArtifactMock.mock.calls[0][0]).not.toHaveProperty('source')
  })

  it('routes the stop button to the main runner cancel and settles the UI', async () => {
    const store = useImageGenerationPresets()

    store.stopGeneration()

    await vi.waitFor(() => expect(cancelIpcMock).toHaveBeenCalledTimes(1))
    // Locally the FSM leaves the processing state immediately.
    expect(store.processing).toBe(false)
  })

  it('reports generation/no-preset and never reaches the runner without a comfy preset', async () => {
    activePresetWithVariant.value = { name: 'Chat', type: 'chat' }
    const store = useImageGenerationPresets()

    const result = await store.generate('imageGen')

    expect(runArtifactMock).not.toHaveBeenCalled()
    expect(errorsReportMock).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })

  it('raises processing so the overlay can show live step text', async () => {
    activePresetWithVariant.value = comfyPresetFixture()
    const store = useImageGenerationPresets()
    runArtifactMock.mockImplementation(async () => {
      expect(store.processing).toBe(true)
      expect(store.currentState).toBe('start_backend')
      expect(store.stepText).toBe('Generating')
      return { state: 'completed', items: [] }
    })

    await store.generate('imageGen')

    expect(store.processing).toBe(false)
  })

  it('projects running progress onto stepText for a tracked run', async () => {
    const store = useImageGenerationPresets()
    store.trackArtifactRun('run-1')
    const event = {
      type: 'artifact-phase',
      runId: 'run-1',
      phase: 'running',
      progress: { current: 3, max: 20 },
      seq: 1,
      scope: { kind: 'run', runId: 'run-1' },
    }
    await vi.waitFor(() => expect(kernelListeners.length).toBeGreaterThan(0))
    for (const listener of kernelListeners) listener(event)

    await vi.waitFor(() => expect(store.stepText).toBe('Generating 3/20'))
    expect(store.processing).toBe(true)
    expect(store.currentState).toBe('generating')
  })

  it('adds a chat tool run’s finished media to the gallery without driving the overlay', async () => {
    const store = useImageGenerationPresets()
    await vi.waitFor(() => expect(kernelListeners.length).toBeGreaterThan(0))
    const owner = { kind: 'tool', toolCallId: 'call-1' }
    const item = {
      id: 'chat-media-1',
      type: 'image' as const,
      state: 'done' as const,
      mode: 'imageGen' as const,
      settings: {},
      imageUrl: 'aipg-media://media/AIPG_Image_00940_.png',
    }
    const tag = { runId: 'in-process-1', origin: 'renderer', owner }
    const scope = { kind: 'run', runId: 'in-process-1' }
    for (const listener of kernelListeners) {
      listener({ type: 'artifact-phase', ...tag, phase: 'running', seq: 1, scope })
      listener({
        type: 'artifact-item',
        ...tag,
        item: { ...item, state: 'generating' },
        seq: 2,
        scope,
      })
    }
    await Promise.resolve()
    expect(store.processing).toBe(false)
    expect(store.generatedImages.some((img) => img.id === item.id)).toBe(false)

    for (const listener of kernelListeners) {
      listener({ type: 'artifact-item', ...tag, item, seq: 3, scope })
    }
    await vi.waitFor(() =>
      expect(store.generatedImages.some((img) => img.id === item.id)).toBe(true),
    )
    expect(store.processing).toBe(false)
  })

  it('adopts panel-owned runs it did not submit itself (Home Agent /imgGen)', async () => {
    const store = useImageGenerationPresets()
    await vi.waitFor(() => expect(kernelListeners.length).toBeGreaterThan(0))
    for (const listener of kernelListeners) {
      listener({
        type: 'artifact-phase',
        runId: 'panel-1',
        origin: 'renderer',
        owner: { kind: 'panel' },
        phase: 'running',
        progress: { current: 2, max: 8 },
        seq: 1,
        scope: { kind: 'run', runId: 'panel-1' },
      })
    }
    await vi.waitFor(() => expect(store.stepText).toBe('Generating 2/8'))
    expect(store.processing).toBe(true)
  })

  it('ignores agent-origin artifact events that were not tracked', async () => {
    const store = useImageGenerationPresets()
    await vi.waitFor(() => expect(kernelListeners.length).toBeGreaterThan(0))
    for (const listener of kernelListeners) {
      listener({
        type: 'artifact-phase',
        runId: 'agent-1',
        phase: 'running',
        origin: 'agent',
        seq: 1,
        scope: { kind: 'run', runId: 'agent-1' },
      })
      listener({
        type: 'artifact-item',
        runId: 'agent-1',
        origin: 'agent',
        item: {
          id: 'agent-media-1',
          type: 'image',
          state: 'done',
          mode: 'imageGen',
          settings: {},
          imageUrl: 'aipg-media://media/agent.png',
        },
        seq: 2,
        scope: { kind: 'run', runId: 'agent-1' },
      })
    }

    await Promise.resolve()
    expect(store.generatedImages.some((img) => img.id === 'agent-media-1')).toBe(false)
    expect(store.processing).toBe(false)
  })
})
