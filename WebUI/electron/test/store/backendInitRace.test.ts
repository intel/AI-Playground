import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The window loads (and initSetup runs) while the service registry is still
// being built. getServices() then returns [] even though a serviceInfoUpdate
// for ai-backend has already arrived. Boot used to treat that as fatal.

const AI_BACKEND = {
  serviceName: 'ai-backend',
  isSetUp: true,
  status: 'notYetStarted',
  baseUrl: 'http://127.0.0.1:59000',
  isRequired: true,
  devices: [],
}

let resolveGetServices: (services: unknown[]) => void
const getServices = vi.fn(
  () =>
    new Promise<unknown[]>((resolve) => {
      resolveGetServices = resolve
    }),
)

let onServiceInfoUpdate: (info: typeof AI_BACKEND) => void = () => {}

vi.stubGlobal('window', {
  electronAPI: {
    getServices,
    getInitSetting: vi.fn(async () => ({
      modelLists: { embedding: [] },
      modelPaths: {},
      version: '0.0.0',
      modelFolderReadOnly: false,
    })),
    onServiceInfoUpdate: vi.fn((cb: (info: typeof AI_BACKEND) => void) => {
      onServiceInfoUpdate = cb
    }),
    onServiceSetUpProgress: vi.fn(),
    getComfyUiDefaultParameters: vi.fn(async () => ''),
    getLlamaCppDefaultParameters: vi.fn(async () => ''),
    resolveBackendVersion: vi.fn(async () => ({ version: '1.0.0' })),
    detectPhisonSsd: vi.fn(async () => ({ detected: false })),
  },
})

vi.mock('@/lib/loopbackAuth', () => ({
  invalidateBackendAuthToken: vi.fn(),
  getBackendAuthToken: vi.fn(async () => 'token'),
}))

vi.mock('@/assets/js/demoAwareStorage', () => ({
  demoAwareStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({
    initPaths: vi.fn(),
  }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  getServices.mockClear()
})

describe('backend init race', () => {
  it('keeps services that arrived via push when a late getServices returns []', async () => {
    const { useBackendServices } = await import('@/assets/js/store/backendServices')
    const store = useBackendServices()

    onServiceInfoUpdate(AI_BACKEND)
    expect(store.info.some((s) => s.serviceName === 'ai-backend')).toBe(true)

    resolveGetServices([])
    await Promise.resolve()
    await Promise.resolve()

    expect(store.info.some((s) => s.serviceName === 'ai-backend')).toBe(true)
  })

  it('initSetup succeeds from the store when getServices is still empty', async () => {
    const { useBackendServices } = await import('@/assets/js/store/backendServices')
    const { useGlobalSetup } = await import('@/assets/js/store/globalSetup')
    const backendServices = useBackendServices()
    const globalSetup = useGlobalSetup()

    onServiceInfoUpdate(AI_BACKEND)
    expect(backendServices.info.some((s) => s.serviceName === 'ai-backend')).toBe(true)

    await globalSetup.initSetup()

    expect(globalSetup.apiHost).toBe('http://127.0.0.1:59000')
  })
})
