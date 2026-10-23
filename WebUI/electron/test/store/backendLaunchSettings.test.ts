import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The backendServices store's half of the kernel-owned settings file
// (step 8, §6.1): the launch flags and version pins hydrate from
// settings.json through the file-backed-preferences helper and write back
// through updateLocalSettings, the device map hydrates from main's
// authoritative copy, and the pre-step-8 Pinia key migrates once — even
// though the section always answers with schema defaults.

const launchSettings = vi.hoisted(() => ({
  versionOverrides: {} as Record<string, { releaseTag?: string; version: string }>,
  comfyUiParameters: null as string | null,
  llamaCppParameters: null as string | null,
  llamaCppBuildVariant: 'standard' as 'standard' | 'ssd-offload',
  llamaCppOffloadDrive: null as string | null,
  openvinoKvCacheU4: false,
  lastSelectedDevicePerBackend: {} as Record<string, string>,
}))

const getBackendLaunchSettings = vi.fn(async () => ({ ...launchSettings }))
const migrateBackendLaunchSettings = vi.fn(
  async (_payload: unknown): Promise<{ success: true } | { success: false; error: string }> => ({
    success: true,
  }),
)
const updateLocalSettings = vi.fn(async (_updates: unknown) => ({ success: true }))
const errorsReport = vi.hoisted(() => vi.fn())

const storage = vi.hoisted(() => ({ data: new Map<string, string>() }))

vi.stubGlobal('window', {
  __AIPG_DEMO_MODE__: false,
  electronAPI: {
    getServices: vi.fn(async () => []),
    onKernelEvent: vi.fn(() => () => {}),
    getKernelSnapshot: vi.fn(async () => ({
      scope: { kind: 'global' },
      sequence: 0,
      state: { services: [], activeTurn: null },
    })),
    onServiceSetUpProgress: vi.fn(),
    getComfyUiDefaultParameters: vi.fn(async () => ''),
    getLlamaCppDefaultParameters: vi.fn(async () => ''),
    resolveBackendVersion: vi.fn(async () => ({ version: '1.0.0' })),
    detectPhisonSsd: vi.fn(async () => ({ detected: false })),
    updateServiceSettings: vi.fn(async () => {}),
    startService: vi.fn(async () => 'running'),
    stopService: vi.fn(async () => 'stopped'),
    selectDevice: vi.fn(async () => {}),
    getBackendLaunchSettings,
    migrateBackendLaunchSettings,
    updateLocalSettings,
  },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})

vi.mock('@/lib/loopbackAuth', () => ({
  invalidateBackendAuthToken: vi.fn(),
  getBackendAuthToken: vi.fn(async () => 'token'),
}))

vi.mock('@/assets/js/demoAwareStorage', () => ({
  isDemoModeActive: () =>
    !!(window as unknown as { __AIPG_DEMO_MODE__?: boolean }).__AIPG_DEMO_MODE__,
  demoAwareStorage: {
    getItem: (key: string) => storage.data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.data.set(key, value)
    },
    removeItem: (key: string) => {
      storage.data.delete(key)
    },
  },
}))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReport }),
}))

const LEGACY_SECTION_PAYLOAD = {
  versionOverrides: { 'llamacpp-backend': { version: 'b4000' } },
  comfyUiParameters: '--legacy-comfy',
  llamaCppParameters: '--legacy-llama',
  llamaCppBuildVariant: 'ssd-offload',
  llamaCppOffloadDrive: 'D:',
  openvinoKvCacheU4: true,
  lastSelectedDeviceIdPerBackend: { 'comfyui-backend': 'GPU.9' },
}

const MIGRATED_FIELDS = {
  versionOverrides: LEGACY_SECTION_PAYLOAD.versionOverrides,
  comfyUiParameters: '--legacy-comfy',
  llamaCppParameters: '--legacy-llama',
  llamaCppBuildVariant: 'ssd-offload',
  llamaCppOffloadDrive: 'D:',
  openvinoKvCacheU4: true,
}

function applyOnlyWhenDefault(payload: unknown): void {
  const incoming = payload as Partial<typeof MIGRATED_FIELDS>
  if (incoming.comfyUiParameters != null && launchSettings.comfyUiParameters === null) {
    launchSettings.comfyUiParameters = incoming.comfyUiParameters
  }
  if (incoming.llamaCppParameters != null && launchSettings.llamaCppParameters === null) {
    launchSettings.llamaCppParameters = incoming.llamaCppParameters
  }
  if (
    incoming.llamaCppBuildVariant === 'ssd-offload' &&
    launchSettings.llamaCppBuildVariant === 'standard'
  ) {
    launchSettings.llamaCppBuildVariant = incoming.llamaCppBuildVariant
  }
  if (incoming.llamaCppOffloadDrive != null && launchSettings.llamaCppOffloadDrive === null) {
    launchSettings.llamaCppOffloadDrive = incoming.llamaCppOffloadDrive
  }
  if (incoming.openvinoKvCacheU4 === true && launchSettings.openvinoKvCacheU4 === false) {
    launchSettings.openvinoKvCacheU4 = true
  }
  if (
    incoming.versionOverrides &&
    Object.keys(incoming.versionOverrides).length > 0 &&
    Object.keys(launchSettings.versionOverrides).length === 0
  ) {
    launchSettings.versionOverrides = incoming.versionOverrides
  }
}

async function freshStore() {
  const { useBackendServices } = await import('@/assets/js/store/backendServices')
  return useBackendServices()
}

const advanceFlush = () => vi.advanceTimersByTimeAsync(350)

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  storage.data.clear()
  errorsReport.mockClear()
  ;(window as unknown as { __AIPG_DEMO_MODE__: boolean }).__AIPG_DEMO_MODE__ = false
  Object.assign(launchSettings, {
    versionOverrides: {},
    comfyUiParameters: null,
    llamaCppParameters: null,
    llamaCppBuildVariant: 'standard',
    llamaCppOffloadDrive: null,
    openvinoKvCacheU4: false,
    lastSelectedDevicePerBackend: {},
  })
  getBackendLaunchSettings.mockImplementation(async () => ({ ...launchSettings }))
  migrateBackendLaunchSettings.mockImplementation(async (payload) => {
    applyOnlyWhenDefault(payload)
    return { success: true as const }
  })
  updateLocalSettings.mockImplementation(async () => ({ success: true as const }))
  vi.mocked(window.electronAPI.detectPhisonSsd).mockImplementation(async () => ({
    detected: false,
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('backend launch settings (settings.json, step 8)', () => {
  it('hydrates the launch fields, device map and version pins from main', async () => {
    getBackendLaunchSettings.mockImplementation(async () => ({
      versionOverrides: { 'llamacpp-backend': { version: 'b5000' } },
      comfyUiParameters: '--comfy',
      llamaCppParameters: '--llama',
      llamaCppBuildVariant: 'ssd-offload',
      llamaCppOffloadDrive: 'D:',
      openvinoKvCacheU4: true,
      lastSelectedDevicePerBackend: {
        'llamacpp-backend': 'GPU.1',
        'whisper-backend:stt': 'NPU',
      },
    }))
    // An SSD is present so the Phison guard does not reset the variant.
    vi.mocked(window.electronAPI.detectPhisonSsd).mockImplementation(async () => ({
      detected: true,
    }))
    const store = await freshStore()
    await store.init()
    expect(store.comfyUiParameters).toBe('--comfy')
    expect(store.llamaCppParameters).toBe('--llama')
    expect(store.llamaCppBuildVariant).toBe('ssd-offload')
    expect(store.llamaCppOffloadDrive).toBe('D:')
    expect(store.openvinoKvCacheU4).toBe(true)
    expect(store.versionState['llamacpp-backend'].uiOverride).toEqual({ version: 'b5000' })
    // Only backend-name keys mirror, never main's ':stt' sub-device entries.
    expect(store.lastSelectedDeviceIdPerBackend['llamacpp-backend']).toBe('GPU.1')
    expect(store.lastSelectedDeviceIdPerBackend['whisper-backend']).toBeNull()
    expect(store.lastSelectedDeviceIdPerBackend['comfyui-backend']).toBeNull()
    await advanceFlush()
    expect(updateLocalSettings).not.toHaveBeenCalled()
  })

  it('migrates the legacy pinia payload even though the section is present', async () => {
    launchSettings.lastSelectedDevicePerBackend = { 'llamacpp-backend': 'GPU.1' }
    vi.mocked(window.electronAPI.detectPhisonSsd).mockImplementation(async () => ({
      detected: true,
    }))
    storage.data.set('backendServices', JSON.stringify(LEGACY_SECTION_PAYLOAD))
    const store = await freshStore()
    await store.init()
    expect(store.comfyUiParameters).toBe('--legacy-comfy')
    expect(store.llamaCppBuildVariant).toBe('ssd-offload')
    expect(store.versionState['llamacpp-backend'].uiOverride).toEqual({ version: 'b4000' })
    // The device mirror uploads to nobody and hydrates from main, not from
    // the stale pinia mirror.
    expect(migrateBackendLaunchSettings).toHaveBeenCalledTimes(1)
    expect(migrateBackendLaunchSettings.mock.calls[0][0]).toEqual(MIGRATED_FIELDS)
    expect(store.lastSelectedDeviceIdPerBackend['llamacpp-backend']).toBe('GPU.1')
    expect(store.lastSelectedDeviceIdPerBackend['comfyui-backend']).toBeNull()
    expect(storage.data.has('backendServices')).toBe(false)
    await advanceFlush()
    expect(updateLocalSettings).not.toHaveBeenCalled()
  })

  it('keeps a non-default settings.json value when leftover differs', async () => {
    launchSettings.comfyUiParameters = '--oem-comfy'
    launchSettings.lastSelectedDevicePerBackend = { 'llamacpp-backend': 'GPU.1' }
    vi.mocked(window.electronAPI.detectPhisonSsd).mockImplementation(async () => ({
      detected: true,
    }))
    storage.data.set('backendServices', JSON.stringify(LEGACY_SECTION_PAYLOAD))
    const store = await freshStore()
    await store.init()
    expect(store.comfyUiParameters).toBe('--oem-comfy')
    expect(store.llamaCppParameters).toBe('--legacy-llama')
    expect(store.llamaCppBuildVariant).toBe('ssd-offload')
    expect(migrateBackendLaunchSettings).toHaveBeenCalledTimes(1)
    expect(migrateBackendLaunchSettings.mock.calls[0][0]).toEqual(MIGRATED_FIELDS)
    expect(store.lastSelectedDeviceIdPerBackend['llamacpp-backend']).toBe('GPU.1')
    expect(storage.data.has('backendServices')).toBe(false)
    await advanceFlush()
    expect(updateLocalSettings).not.toHaveBeenCalled()
  })

  it('keeps the legacy key and reports when the upload is refused', async () => {
    storage.data.set('backendServices', JSON.stringify(LEGACY_SECTION_PAYLOAD))
    migrateBackendLaunchSettings.mockImplementation(async () => ({
      success: false as const,
      error: 'rejected',
    }))
    const store = await freshStore()
    await store.init()
    expect(store.comfyUiParameters).toBeNull()
    expect(storage.data.has('backendServices')).toBe(true)
    expect(errorsReport).toHaveBeenCalledTimes(1)
    expect(errorsReport.mock.calls[0][1]).toMatchObject({
      code: 'backend-launch-settings/migrate-failed',
    })
  })

  it('writes changed launch fields through to updateLocalSettings', async () => {
    const store = await freshStore()
    await store.init()
    store.comfyUiParameters = '--user-flag'
    await advanceFlush()
    expect(updateLocalSettings).toHaveBeenCalledTimes(1)
    expect(updateLocalSettings.mock.calls[0][0]).toEqual({
      versionOverrides: {},
      comfyUiParameters: '--user-flag',
      llamaCppParameters: null,
      llamaCppBuildVariant: 'standard',
      llamaCppOffloadDrive: null,
      openvinoKvCacheU4: false,
    })
  })

  it('keeps demo-session changes ephemeral', async () => {
    ;(window as unknown as { __AIPG_DEMO_MODE__: boolean }).__AIPG_DEMO_MODE__ = true
    storage.data.set('backendServices', JSON.stringify(LEGACY_SECTION_PAYLOAD))
    const store = await freshStore()
    await store.init()
    // The session-scoped leftover hydrates and clears, but nothing reaches
    // machine config.
    expect(store.comfyUiParameters).toBe('--legacy-comfy')
    expect(migrateBackendLaunchSettings).not.toHaveBeenCalled()
    store.comfyUiParameters = '--demo-flag'
    await advanceFlush()
    expect(updateLocalSettings).not.toHaveBeenCalled()
  })

  it('re-runs the Phison guard against the hydrated variant', async () => {
    launchSettings.llamaCppBuildVariant = 'ssd-offload'
    const store = await freshStore()
    await store.init()
    // No SSD on this machine: whichever probe lands (the setup-time one or
    // init's re-run), the hydrated ssd-offload variant resets.
    await vi.advanceTimersByTimeAsync(10)
    expect(store.llamaCppBuildVariant).toBe('standard')
    await advanceFlush()
    expect(updateLocalSettings).toHaveBeenCalledTimes(1)
    expect(
      (updateLocalSettings.mock.calls[0][0] as { llamaCppBuildVariant?: string })
        .llamaCppBuildVariant,
    ).toBe('standard')
  })
})
