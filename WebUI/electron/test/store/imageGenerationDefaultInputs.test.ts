import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The default input fill against the real ComfyUI settings store: it writes only into
// the open Session's settings, and only for presets that take an image.

const fakePresets = await vi.hoisted(async () => {
  const { reactive } = await import('vue')
  return reactive({
    presets: [] as unknown[],
    activeVariantName: {} as Record<string, string>,
    activePresetWithVariant: null as unknown,
    getFirstVariantName: () => undefined,
  })
})

vi.mock('@/assets/js/store/comfyUiPresets', () => ({ useComfyUiPresets: () => ({}) }))
vi.mock('@/assets/js/store/demoMode', () => ({ useDemoMode: () => ({ enabled: false }) }))
vi.mock('@/assets/js/store/i18n', () => ({ useI18N: () => ({ state: {} }) }))
vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: vi.fn() }) }))
vi.mock('@/assets/js/store/backendServices', () => ({ useBackendServices: () => ({}) }))
vi.mock('@/assets/js/projection/kernelProjection', () => ({
  connectKernelEventStream: () => ({ ready: Promise.resolve(), dispose: vi.fn() }),
}))
vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => fakePresets,
  presetRequiresUserPrompt: vi.fn(() => false),
}))
vi.mock('@/assets/js/store/ui', () => ({ useUIStore: () => ({}) }))
vi.mock('@/assets/js/store/imageGenerationUtils', () => ({
  getMissingComfyuiBackendModels: vi.fn(async () => []),
}))
vi.mock('@/assets/js/permissions/permissions', () => ({ requestDownload: vi.fn(async () => {}) }))
vi.mock('@/lib/utils', () => ({
  imageUrlToDataUri: vi.fn(async () => 'data:image/png;base64,AAAA'),
  saveImageToMediaInput: vi.fn(async () => 'aipg-media://media/input/copied.png'),
}))
vi.mock('@/lib/laminarSpans', () => ({
  withTraceSpan: vi.fn((_name: string, fn: () => unknown) => fn()),
}))
vi.mock('@/assets/js/artifact/runArtifact', () => ({
  runArtifact: vi.fn(async () => ({ status: 'completed' })),
}))
vi.mock('@/assets/js/store/demoModeDefaults', () => ({
  getDemoModeInputImage: () => null,
  getDemoModeSketchInputImage: () => null,
  getDemoModeUpscaleInputImage: () => null,
}))

const imageInput = (nodeTitle: string, optional?: boolean) => ({
  nodeTitle,
  nodeInput: 'image',
  type: 'image',
  label: nodeTitle,
  defaultValue: '',
  optional,
})

const preset = (name: string, category: string, settings: unknown[]) => ({
  type: 'comfy',
  backend: 'comfyui',
  name,
  category,
  settings,
})

const editPreset = preset('Edit By Prompt', 'edit-images', [
  imageInput('Load Image'),
  imageInput('Reference', true),
])
const textVideo = preset('Text To Video', 'create-videos', [])
const imageGen = preset('Fast', 'create-images', [imageInput('Style Reference', true)])

type Values = { settings: Record<string, unknown>; inputs: Record<string, unknown> }

beforeEach(() => {
  setActivePinia(createPinia())
  fakePresets.activePresetWithVariant = null
  globalThis.window = {
    electronAPI: {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Window & typeof globalThis
  globalThis.localStorage = {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  } as unknown as Storage
})

const { useImageGenerationPresets } = await import('@/assets/js/store/imageGenerationPresets')

function bound() {
  const store = useImageGenerationPresets()
  const session: Record<string, Values> = {}
  store.bindSessionSettings({
    use: (key, defaults) => (session[key] ??= defaults),
    peek: (key) => session[key] ?? null,
    write: (key, values) => {
      session[key] = values
    },
  })
  return { store, session }
}

const url = 'aipg-media://sessions/s1/files/fox.png'

describe('fillDefaultReference', () => {
  it("fills an edit preset's required image input inside the Session's settings", () => {
    fakePresets.activePresetWithVariant = editPreset
    const { store, session } = bound()
    store.loadSettingsForActivePreset()

    expect(store.defaultImageInputMode).toBe('imageEdit')
    expect(store.fillDefaultReference(url)).toBe(true)
    expect(session['Edit By Prompt'].inputs).toEqual({ 'Load Image.image': url })
    expect(store.comfyInputsPerPreset['Edit By Prompt']).toBeUndefined()
  })

  it('writes nothing while no Session holds the preset', () => {
    fakePresets.activePresetWithVariant = editPreset
    const store = useImageGenerationPresets()
    expect(store.fillDefaultReference(url)).toBe(false)
    expect(store.comfyInputsPerPreset).toEqual({})
  })

  it('leaves image-generation and text-only video presets alone', () => {
    const { store, session } = bound()
    for (const active of [imageGen, textVideo]) {
      fakePresets.activePresetWithVariant = active
      store.loadSettingsForActivePreset()
      expect(store.defaultImageInputMode).toBeNull()
      expect(store.fillDefaultReference(url)).toBe(false)
    }
    expect(session['Fast'].inputs).toEqual({})
  })

  it('records the Edit button as a pick for the mode it targets', async () => {
    const store = useImageGenerationPresets()
    await store.copyImageAsInputForMode(
      { id: 'i1', type: 'image', state: 'done', mode: 'imageGen', imageUrl: url, settings: {} },
      'imageEdit',
    )
    expect(store.inputPick?.mode).toBe('imageEdit')
  })
})
