import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The renderer half of step 8's generated-media slice (architecture-target
// §6.1, step 11): the store hydrates the gallery from the kernel's record
// files before mount, uploads the legacy Pinia-persisted gallery once (then
// slims it out of the leftover key). Nothing writes records any more: the
// gallery reads every Session's History Entries instead.

const { errorsReport } = vi.hoisted(() => ({ errorsReport: vi.fn() }))

vi.mock('@/assets/js/store/comfyUiPresets', () => ({
  useComfyUiPresets: () => ({}),
}))

vi.mock('@/assets/js/store/demoMode', () => ({
  useDemoMode: () => ({ enabled: false }),
}))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ state: { COM_GENERATING: 'Generating' } }),
}))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReport }),
}))

vi.mock('@/assets/js/store/backendServices', () => ({
  useBackendServices: () => ({}),
}))

vi.mock('@/assets/js/projection/kernelProjection', () => ({
  connectKernelEventStream: () => ({ ready: Promise.resolve(), dispose: vi.fn() }),
}))

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({ presets: [], activeVariantName: {} }),
  presetRequiresUserPrompt: vi.fn(() => false),
}))

vi.mock('@/assets/js/store/ui', () => ({
  useUIStore: () => ({}),
}))

vi.mock('@/assets/js/store/imageGenerationUtils', () => ({
  getMissingComfyuiBackendModels: vi.fn(async () => []),
}))

vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload: vi.fn(async () => {}),
}))

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

const mediaItemsApi = {
  bootstrap: vi.fn(),
  migrate: vi.fn(),
  save: vi.fn(async (_items: unknown[]): Promise<{ success: boolean; error?: string }> => ({
    success: true,
  })),
  delete: vi.fn(async (_ids: string[]): Promise<{ success: boolean; error?: string }> => ({
    success: true,
  })),
}

// The store's init also hydrates its per-preset settings half via the
// preferences file helper (step 8); absent sections keep the defaults.
const preferencesApi = {
  read: vi.fn(
    async (): Promise<
      { success: true; sections: Record<string, unknown> } | { success: false; error: string }
    > => ({ success: true, sections: {} }),
  ),
  migrate: vi.fn(
    async (
      _section: string,
      _payload: unknown,
    ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
  ),
  write: vi.fn(
    async (
      _section: string,
      _value: unknown,
    ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
  ),
}

let storage: Map<string, string>
let windowListeners: Record<string, Array<() => void>>

function fakeWindow(): void {
  storage = new Map()
  windowListeners = {}
  const localStorageShim = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }
  globalThis.localStorage = localStorageShim as unknown as Storage
  globalThis.sessionStorage = localStorageShim as unknown as Storage
  globalThis.window = {
    electronAPI: { mediaItems: mediaItemsApi, preferences: preferencesApi },
    __AIPG_DEMO_MODE__: false,
    addEventListener: (event: string, handler: () => void) => {
      ;(windowListeners[event] ??= []).push(handler)
    },
    removeEventListener: (event: string, handler: () => void) => {
      windowListeners[event] = (windowListeners[event] ?? []).filter((h) => h !== handler)
    },
  } as unknown as Window & typeof globalThis
}

beforeEach(() => {
  setActivePinia(createPinia())
  fakeWindow()
  vi.useFakeTimers()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  // @ts-expect-error test teardown of the fakes
  delete globalThis.window
  // @ts-expect-error test teardown of the fakes
  delete globalThis.localStorage
  // @ts-expect-error test teardown of the fakes
  delete globalThis.sessionStorage
})

const { useImageGenerationPresets } = await import('@/assets/js/store/imageGenerationPresets')

type Store = ReturnType<typeof useImageGenerationPresets>

const doneImage = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    type: 'image',
    state: 'done',
    mode: 'imageGen',
    imageUrl: `aipg-media://media/${id}.png`,
    settings: { preset: 'Pro Image' },
    createdAt: 1,
    ...overrides,
  }) as never

const seededKey = (gallery: unknown[]): void => {
  storage.set(
    'imageGenerationPresets',
    JSON.stringify({
      settingsPerPreset: { 'Pro Image': { width: 1024 } },
      comfyInputsPerPreset: {},
      generatedImages: gallery,
    }),
  )
}

const advanceFlush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(350)
}

describe('useImageGenerationPresets media-record hydration', () => {
  it('hydrates the old gallery records once', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'ok', items: [doneImage('item-1')] })
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(store.generatedImages).toHaveLength(1)
    expect(mediaItemsApi.migrate).not.toHaveBeenCalled()
    // init is idempotent — a second call does not re-hydrate.
    await store.init()
    expect(mediaItemsApi.bootstrap).toHaveBeenCalledTimes(1)
  })

  it('uploads the legacy gallery once and slims it out of the leftover key', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'empty' })
    mediaItemsApi.migrate.mockResolvedValue({
      status: 'ok',
      items: [doneImage('legacy-1')],
    })
    seededKey([doneImage('legacy-1')])
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(mediaItemsApi.migrate).toHaveBeenCalledTimes(1)
    expect(store.generatedImages.map((item) => (item as { id: string }).id)).toEqual(['legacy-1'])
    // The per-preset settings half reads the same key and slims its own
    // fields out after uploading them; with both halves migrated the key
    // runs empty and disappears — no dual-write left behind.
    expect(store.settingsPerPreset).toEqual({ 'Pro Image': { width: 1024 } })
    expect(preferencesApi.migrate).toHaveBeenCalledWith('imageGenerationPresets', {
      settingsPerPreset: { 'Pro Image': { width: 1024 } },
      comfyInputsPerPreset: {},
    })
    expect(storage.has('imageGenerationPresets')).toBe(false)
  })

  it('merges a stranded legacy gallery even when the files already hold items', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({
      status: 'ok',
      items: [doneImage('session-item')],
    })
    mediaItemsApi.migrate.mockResolvedValue({
      status: 'ok',
      items: [doneImage('legacy-item'), doneImage('session-item')],
    })
    seededKey([doneImage('legacy-item')])
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(mediaItemsApi.migrate).toHaveBeenCalledTimes(1)
    const ids = store.generatedImages.map((item) => (item as { id: string }).id)
    expect(ids).toEqual(['legacy-item', 'session-item'])
    expect(
      (JSON.parse(storage.get('imageGenerationPresets') ?? '{}') as Record<string, unknown>)
        .generatedImages,
    ).toBeUndefined()
  })

  it('keeps the legacy gallery in the key when the upload fails, to retry next boot', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'empty' })
    mediaItemsApi.migrate.mockResolvedValue({ status: 'error', error: 'disk full' })
    seededKey([doneImage('legacy-1')])
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(errorsReport).toHaveBeenCalled()
    const key = JSON.parse(storage.get('imageGenerationPresets') ?? '{}') as Record<string, unknown>
    expect(Array.isArray(key.generatedImages)).toBe(true)
    // The settings half still migrates and slims its own fields out; only the
    // gallery copy stays behind for the media retry next boot.
    expect(key.settingsPerPreset).toBeUndefined()
  })

  it('slims an empty legacy gallery payload and reports a failed bootstrap', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'error', error: 'store not ready' })
    seededKey([])
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(errorsReport).toHaveBeenCalled()
    expect(store.generatedImages).toEqual([])
  })

  it('drops the leftover key when the gallery was the last remaining field', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'empty' })
    mediaItemsApi.migrate.mockResolvedValue({
      status: 'ok',
      items: [doneImage('legacy-1')],
    })
    storage.set(
      'imageGenerationPresets',
      JSON.stringify({ generatedImages: [doneImage('legacy-1')] }),
    )
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(store.generatedImages.map((item) => (item as { id: string }).id)).toEqual(['legacy-1'])
    expect(storage.has('imageGenerationPresets')).toBe(false)
  })
})

describe('useImageGenerationPresets after the gallery moved to Sessions', () => {
  it('writes no gallery record for an added, projected, deleted or quit-time item', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'ok', items: [] })
    const store: Store = useImageGenerationPresets()
    await store.init()

    store.addGalleryItem(doneImage('reference'))
    store.updateImage(doneImage('projected'))
    store.deleteImage('reference')
    store.deleteAllImages()
    for (const handler of windowListeners.beforeunload ?? []) handler()
    await advanceFlush()

    expect(mediaItemsApi.save).not.toHaveBeenCalled()
    expect(mediaItemsApi.delete).not.toHaveBeenCalled()
  })
})
