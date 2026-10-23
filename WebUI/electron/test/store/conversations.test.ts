import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The renderer half of step 8 (architecture-target §6.1): the store is the
// live projection, the kernel owns the files. Covered here: pre-mount
// hydration, the one-shot localStorage migration (upload + key removal),
// and which mutations forward to the writer — and which deliberately do not
// (an empty main draft stays in memory until it has content).

const { errorsReport } = vi.hoisted(() => ({ errorsReport: vi.fn() }))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReport }),
}))

type ConversationsApi = {
  bootstrap: ReturnType<typeof vi.fn>
  migrate: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  saveLastMainKey: ReturnType<typeof vi.fn>
}

let api: ConversationsApi
let storage: Map<string, string>

function fakeWindow(): void {
  api = {
    bootstrap: vi.fn(),
    migrate: vi.fn(),
    save: vi.fn(async () => ({ success: true as const })),
    delete: vi.fn(async () => ({ success: true as const })),
    saveLastMainKey: vi.fn(async () => ({ success: true as const })),
  }
  storage = new Map()
  const localStorageShim = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }
  // demoAwareStorage reads the BARE `localStorage` global, not window.localStorage.
  globalThis.localStorage = localStorageShim as unknown as Storage
  globalThis.sessionStorage = localStorageShim as unknown as Storage
  globalThis.window = {
    electronAPI: { conversations: api },
    __AIPG_DEMO_MODE__: false,
    localStorage: localStorageShim,
  } as unknown as Window & typeof globalThis
}

beforeEach(() => {
  setActivePinia(createPinia())
  fakeWindow()
  errorsReport.mockClear()
})

afterEach(async () => {
  // @ts-expect-error test teardown of the fake window
  delete globalThis.window
  // @ts-expect-error test teardown of the storage shims
  delete globalThis.localStorage
  // @ts-expect-error test teardown of the storage shims
  delete globalThis.sessionStorage
})

const okBootstrap = (threads: unknown[], lastMainKey: string | null = null) => ({
  status: 'ok' as const,
  lastMainKey,
  threads,
})

describe('useConversations hydration', () => {
  it('hydrates from the kernel files before the app mounts', async () => {
    api.bootstrap.mockResolvedValue(
      okBootstrap(
        [
          {
            id: '100',
            meta: { presetName: 'Qwen', kind: 'main' },
            ragHashes: ['hash-a'],
            messages: [{ id: 'u', role: 'user', parts: [] }],
          },
        ],
        '100',
      ),
    )
    const { useConversations } = await import('@/assets/js/store/conversations')
    const store = useConversations()

    await store.init()

    expect(api.migrate).not.toHaveBeenCalled()
    expect(store.conversationList['100']).toHaveLength(1)
    expect(store.getThreadMeta('100')).toMatchObject({ presetName: 'Qwen', kind: 'main' })
    expect(store.getThreadRagHashes('100')).toEqual(['hash-a'])
    // The session opens on an empty main draft; it is memory-only.
    const draftKeys = Object.keys(store.conversationList).filter((k) => k !== '100')
    expect(draftKeys).toHaveLength(1)
    expect(store.conversationList[draftKeys[0]]).toEqual([])
    expect(store.activeKey).toBe(draftKeys[0])
    expect(api.save).not.toHaveBeenCalled()
    // The draft becomes the last main thread once the watcher settles.
    await vi.waitFor(() => expect(store.lastMainKey).toBe(draftKeys[0]))
  })

  it('migrates the legacy localStorage state once and drops the key', async () => {
    api.bootstrap.mockResolvedValue({ status: 'empty' })
    api.migrate.mockImplementation(async (payload: unknown) => {
      const legacy = payload as { conversationList: Record<string, unknown[]> }
      const ids = Object.keys(legacy.conversationList)
      return okBootstrap(
        ids.map((id) => ({ id, meta: null, ragHashes: [], messages: [] })),
        null,
      )
    })
    storage.set(
      'conversations',
      JSON.stringify({
        conversationList: { '100': [{ id: 'u', role: 'user', parts: [] }] },
        conversationThreadMeta: { '100': { presetName: 'Qwen', kind: 'main' } },
        conversationRagSelection: {},
        lastMainKey: '100',
      }),
    )
    const { useConversations } = await import('@/assets/js/store/conversations')
    const store = useConversations()

    await store.init()

    expect(api.migrate).toHaveBeenCalledTimes(1)
    expect(api.migrate.mock.calls[0][0].conversationList).toHaveProperty('100')
    expect(storage.has('conversations')).toBe(false)
    expect(store.conversationList['100']).toEqual([])
  })

  it('migrates leftover when files own an empty index (stranded-list rescue)', async () => {
    api.bootstrap.mockResolvedValue(okBootstrap([]))
    api.migrate.mockImplementation(async (payload: unknown) => {
      const legacy = payload as { conversationList: Record<string, unknown[]> }
      const ids = Object.keys(legacy.conversationList)
      return okBootstrap(
        ids.map((id) => ({ id, meta: null, ragHashes: [], messages: [] })),
        null,
      )
    })
    storage.set(
      'conversations',
      JSON.stringify({
        conversationList: { '100': [{ id: 'u', role: 'user', parts: [] }] },
      }),
    )
    const { useConversations } = await import('@/assets/js/store/conversations')
    const store = useConversations()

    await store.init()

    expect(api.migrate).toHaveBeenCalledTimes(1)
    expect(store.conversationList['100']).toEqual([])
    expect(storage.has('conversations')).toBe(false)
  })

  it('skips migration on a fresh install with no legacy key', async () => {
    api.bootstrap.mockResolvedValue({ status: 'empty' })
    const { useConversations } = await import('@/assets/js/store/conversations')
    const store = useConversations()

    await store.init()

    expect(api.migrate).not.toHaveBeenCalled()
    expect(Object.keys(store.conversationList)).toHaveLength(1) // the draft
  })

  it('keeps working (empty) when the file store fails to answer', async () => {
    api.bootstrap.mockRejectedValue(new Error('ipc gone'))
    const { useConversations } = await import('@/assets/js/store/conversations')
    const store = useConversations()

    await expect(store.init()).resolves.toBeUndefined()
    expect(Object.keys(store.conversationList)).toHaveLength(1) // the draft
  })

  it('init is idempotent — a second call does not re-hydrate', async () => {
    api.bootstrap.mockResolvedValue(okBootstrap([]))
    const { useConversations } = await import('@/assets/js/store/conversations')
    const store = useConversations()

    await store.init()
    await store.init()

    expect(api.bootstrap).toHaveBeenCalledTimes(1)
  })

  it('drops leftover localStorage when files already own the conversations', async () => {
    storage.set(
      'conversations',
      JSON.stringify({
        conversationList: { stale: [{ id: 'u', role: 'user', parts: [] }] },
      }),
    )
    api.bootstrap.mockResolvedValue(
      okBootstrap(
        [
          {
            id: '1',
            meta: { presetName: 'Qwen', kind: 'main' },
            ragHashes: [],
            messages: [{ id: 'u', role: 'user', parts: [] }],
          },
        ],
        '1',
      ),
    )
    const { useConversations } = await import('@/assets/js/store/conversations')
    const store = useConversations()

    await store.init()

    expect(api.migrate).not.toHaveBeenCalled()
    expect(store.conversationList['1']).toHaveLength(1)
    expect(storage.has('conversations')).toBe(false)
  })
})

describe('useConversations write-through', () => {
  async function hydratedStore() {
    api.bootstrap.mockResolvedValue(okBootstrap([]))
    const { useConversations } = await import('@/assets/js/store/conversations')
    const store = useConversations()
    await store.init()
    api.save.mockClear()
    api.delete.mockClear()
    api.saveLastMainKey.mockClear()
    return store
  }

  it('keeps a generate settle in the live copy without writing the file', async () => {
    const store = await hydratedStore()
    const key = store.addNewConversation()

    store.applyConversationMessages(
      [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as never,
      key,
    )

    expect(api.save).not.toHaveBeenCalled()
    expect(store.conversationList[key]).toHaveLength(1)
  })

  it('forwards TTS/STT-style updateConversation, delete, clear and rename', async () => {
    const store = await hydratedStore()
    const key = store.addNewConversation()
    store.updateConversation(
      [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as never,
      key,
    )
    expect(api.save).toHaveBeenCalledTimes(1)
    api.save.mockClear()

    store.renameConversationTitle(key, 'Renamed')
    expect(api.save).toHaveBeenCalledTimes(1)

    store.clearConversation(key)
    expect(api.save).toHaveBeenCalledTimes(2)

    store.deleteConversation(key)
    expect(api.delete).toHaveBeenCalledWith(key)
    expect(store.conversationList[key]).toBeUndefined()
  })

  it('does not persist stamp-style setThreadMeta; the engine snapshot does', async () => {
    const store = await hydratedStore()
    const key = store.addNewConversation()
    store.setThreadMeta(key, { presetName: 'Qwen', kind: 'main' })
    expect(api.save).not.toHaveBeenCalled()
    expect(store.getThreadMeta(key)).toMatchObject({ presetName: 'Qwen', kind: 'main' })
  })

  it('persists a Home Agent thread on create, before any content', async () => {
    const store = await hydratedStore()

    store.createConversation({ kind: 'homeAgent', presetName: 'Home Agent' })

    expect(api.save).toHaveBeenCalledTimes(1)
    expect(api.save.mock.calls[0][0]).toMatchObject({
      meta: { kind: 'homeAgent', presetName: 'Home Agent' },
    })
  })

  it('does not write an empty main draft until it has content', async () => {
    const store = await hydratedStore()
    store.addNewConversation() // reuses/allocates the empty draft

    expect(api.save).not.toHaveBeenCalled()
  })

  it('swallows a failed save instead of breaking the turn', async () => {
    const store = await hydratedStore()
    const key = store.addNewConversation()
    api.save.mockRejectedValue(new Error('disk full'))

    expect(() =>
      store.updateConversation(
        [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as never,
        key,
      ),
    ).not.toThrow()
    await vi.waitFor(() => expect(api.save).toHaveBeenCalled())
    // The live copy survived.
    expect(store.conversationList[key]).toHaveLength(1)
  })

  it('reports a failed persist reply without dropping the live copy', async () => {
    const store = await hydratedStore()
    const key = store.addNewConversation()
    api.save.mockResolvedValueOnce({ success: false, error: 'disk full' })

    expect(() =>
      store.updateConversation(
        [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as never,
        key,
      ),
    ).not.toThrow()
    await vi.waitFor(() => expect(errorsReport).toHaveBeenCalled())
    expect(errorsReport.mock.calls[0][0]).toMatchObject({ message: 'disk full' })
    expect(store.conversationList[key]).toHaveLength(1)
  })
})
