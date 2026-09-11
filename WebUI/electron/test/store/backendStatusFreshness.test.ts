import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// startService() / stopService() resolve with the status the transition ended in,
// while the matching serviceInfoUpdate push arrives a tick later. Callers that
// await a start and then read `info` — the on-demand speech sidecars resolve their
// endpoint immediately afterwards — must not see the pre-start status. These tests
// pin that the store folds the returned status in straight away.

const NOT_STARTED = {
  serviceName: 'whisper-backend',
  isSetUp: true,
  status: 'notYetStarted',
  baseUrl: 'http://127.0.0.1:56000',
  isRequired: false,
  devices: [],
}

const startService = vi.fn(async () => 'running')
const stopService = vi.fn(async () => 'stopped')

vi.stubGlobal('window', {
  electronAPI: {
    getServices: vi.fn(async () => [NOT_STARTED]),
    // Never fires in these tests: that is the point — the push is what lags.
    onServiceInfoUpdate: vi.fn(),
    onServiceSetUpProgress: vi.fn(),
    getComfyUiDefaultParameters: vi.fn(async () => ''),
    getLlamaCppDefaultParameters: vi.fn(async () => ''),
    resolveBackendVersion: vi.fn(async () => ({ version: '1.0.0' })),
    detectPhisonSsd: vi.fn(async () => ({ detected: false })),
    updateServiceSettings: vi.fn(async () => {}),
    startService,
    stopService,
  },
})

vi.mock('@/lib/loopbackAuth', () => ({
  invalidateBackendAuthToken: vi.fn(),
  getBackendAuthToken: vi.fn(async () => 'token'),
}))

vi.mock('@/assets/js/demoAwareStorage', () => ({
  demoAwareStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

async function freshStore() {
  const { useBackendServices } = await import('@/assets/js/store/backendServices')
  const store = useBackendServices()
  // Seed the cache the way the initial getServices() would.
  await vi.waitFor(() => expect(store.info.length).toBeGreaterThan(0))
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  startService.mockResolvedValue('running')
  stopService.mockResolvedValue('stopped')
})

describe('backend status freshness', () => {
  it('reports the started service as running before any serviceInfoUpdate arrives', async () => {
    const store = await freshStore()
    expect(store.info.find((s) => s.serviceName === 'whisper-backend')?.status).toBe(
      'notYetStarted',
    )

    const returned = await store.startService('whisper-backend')

    expect(returned).toBe('running')
    expect(store.info.find((s) => s.serviceName === 'whisper-backend')?.status).toBe('running')
  })

  it('keeps the rest of the service entry intact', async () => {
    const store = await freshStore()

    await store.startService('whisper-backend')

    const svc = store.info.find((s) => s.serviceName === 'whisper-backend')
    expect(svc?.baseUrl).toBe('http://127.0.0.1:56000')
    expect(svc?.isSetUp).toBe(true)
  })

  it('folds a failed start in too, rather than leaving a stale status', async () => {
    startService.mockResolvedValue('failed')
    const store = await freshStore()

    await store.startService('whisper-backend')

    expect(store.info.find((s) => s.serviceName === 'whisper-backend')?.status).toBe('failed')
  })

  it('does the same for stops', async () => {
    const store = await freshStore()
    await store.startService('whisper-backend')

    await store.stopService('whisper-backend')

    expect(store.info.find((s) => s.serviceName === 'whisper-backend')?.status).toBe('stopped')
  })
})
