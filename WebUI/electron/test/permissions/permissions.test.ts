import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const requestDownloadIpc = vi.fn(
  async (): Promise<{ success: true } | { success: false; error: string }> => ({
    success: true,
  }),
)
const requestVramWarningIpc = vi.fn(async () => ({ success: true as const, confirmed: true }))
const showWarningDialog = vi.fn()

vi.mock('@/assets/js/store/dialogs', () => ({
  useDialogStore: () => ({ showWarningDialog }),
}))
vi.mock('@/assets/js/demoAwareStorage', () => ({
  demoAwareStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

vi.stubGlobal('window', {
  electronAPI: {
    permissions: {
      requestDownload: requestDownloadIpc,
      requestVramWarning: requestVramWarningIpc,
    },
  },
})

const { notify, requestDownload, requestVramWarning } =
  await import('@/assets/js/permissions/permissions')
const { usePermissionGrants, vramWarningGrantKey } =
  await import('@/assets/js/store/permissionGrants')

function fakeLocalStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  const keys = () => [...store.keys()]
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    key: (index: number) => keys()[index] ?? null,
    get length() {
      return store.size
    },
    remaining: keys,
  }
}

describe('permissions facade', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.stubGlobal('window', {
      electronAPI: {
        permissions: {
          requestDownload: requestDownloadIpc,
          requestVramWarning: requestVramWarningIpc,
        },
      },
    })
  })

  it('forwards download consent to main policy', async () => {
    const models = [{ repo_id: 'test/model' }] as DownloadModelParam[]
    await requestDownload(models)
    expect(requestDownloadIpc).toHaveBeenCalledWith(models)
  })

  it('rejects when main reports a declined download', async () => {
    requestDownloadIpc.mockResolvedValueOnce({ success: false, error: 'cancelled' })
    await expect(requestDownload([{ repo_id: 'x' }] as DownloadModelParam[])).rejects.toThrow(
      'cancelled',
    )
  })

  it('forwards the VRAM warning to main policy', async () => {
    requestVramWarningIpc.mockResolvedValueOnce({ success: true, confirmed: false })
    await expect(
      requestVramWarning({ presetName: 'LTX-Video', message: 'needs lots of VRAM' }),
    ).resolves.toBe(false)
    expect(requestVramWarningIpc).toHaveBeenCalledWith({
      presetName: 'LTX-Video',
      message: 'needs lots of VRAM',
    })
  })

  it('shows the guidance notice and runs the confirm action', () => {
    const onConfirm = vi.fn()
    notify('install me', onConfirm)
    const [message, confirmFn] = showWarningDialog.mock.calls[0]
    expect(message).toBe('install me')
    confirmFn()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('the grant list (legacy import)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.unstubAllGlobals()
  })

  it('imports the legacy localStorage memory-alert suppressions once, as remember grants', async () => {
    const storage = fakeLocalStorage({
      'memoryAlertSuppress_LTX-Video': '1',
      'memoryAlertSuppress_Wan2.1-VACE': '1',
      memoryAlertSuppress_Stale: '0',
      unrelated: '1',
    })
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', {
      electronAPI: undefined,
      __AIPG_DEMO_MODE__: false,
    })
    setActivePinia(createPinia())
    const grants = usePermissionGrants()
    await grants.init()

    expect(grants.has(vramWarningGrantKey('LTX-Video'))).toBe(true)
    expect(grants.has(vramWarningGrantKey('Wan2.1-VACE'))).toBe(true)
    expect(storage.remaining()).toEqual(['unrelated'])
  })
})
