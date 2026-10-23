import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatPreset } from '@/assets/js/store/presets'

// The renderer half of step 8's agent-session slice (architecture-target
// §6.1): the store hydrates from the kernel's files before mount, uploads the
// legacy Pinia-persisted records once (then strips them from the storage key),
// and writes records + the active id through as they change — gated until
// hydration so nothing writes on behalf of an unhydrated map. The same
// contract covers the last-used workspace pointers (agent-workspace.json),
// which share the legacy key and slim out after their own one-shot upload.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'pick',
} as ChatPreset

const activePreset = ref<ChatPreset>(AGENT)

const { errorsReport } = vi.hoisted(() => ({ errorsReport: vi.fn() }))

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    presets: [AGENT],
    get activePresetWithVariant() {
      return activePreset.value
    },
  }),
}))

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({
    switchPreset: vi.fn(async () => ({ success: true })),
  }),
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({ backend: 'llamaCPP', ensureReadyForInference: vi.fn() }),
}))

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({ checkModelAlreadyLoaded: vi.fn().mockResolvedValue([]) }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReport }),
}))

vi.mock('@/assets/js/tools/agentBridge', () => ({
  getAgentToolSpecs: () => [],
}))

vi.mock('@ai-sdk/vue', () => ({
  Chat: class {
    messages: unknown[] = []
    error = undefined
    sendMessage = vi.fn()
    stop = vi.fn()
  },
}))

const agentModeApi = {
  cancel: vi.fn(async () => {}),
  deleteSession: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({
    success: true,
  })),
  onExecuteTool: vi.fn(),
  bootstrapSessions: vi.fn(),
  migrateSessions: vi.fn(),
  saveSession: vi.fn(async (_record: unknown): Promise<{ success: boolean; error?: string }> => ({
    success: true,
  })),
  saveActiveSessionId: vi.fn(
    async (_id: string | null): Promise<{ success: boolean; error?: string }> => ({
      success: true,
    }),
  ),
  readWorkspaceState: vi.fn(
    async (): Promise<
      | {
          success: true
          section: { workspaceDir: string; lastWorkspaceByKind: Record<string, string> } | null
        }
      | { success: false; error: string }
    > => ({ success: true, section: null }),
  ),
  migrateWorkspaceState: vi.fn(
    async (): Promise<{ success: true } | { success: false; error: string }> => ({
      success: true,
    }),
  ),
  writeWorkspaceState: vi.fn(
    async (): Promise<{ success: true } | { success: false; error: string }> => ({
      success: true,
    }),
  ),
}

let storage: Map<string, string>

function fakeWindow(): void {
  storage = new Map()
  const localStorageShim = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }
  globalThis.localStorage = localStorageShim as unknown as Storage
  globalThis.sessionStorage = localStorageShim as unknown as Storage
  globalThis.window = {
    electronAPI: {
      agentMode: agentModeApi,
      getLocaleSettings: vi.fn(async () => ({ languageOverride: null })),
      games: {
        read: vi.fn(async () => null),
        list: vi.fn(async () => []),
      },
    },
  } as unknown as Window & typeof globalThis
}

beforeEach(() => {
  setActivePinia(createPinia())
  fakeWindow()
  vi.clearAllMocks()
  errorsReport.mockClear()
})

afterEach(() => {
  // @ts-expect-error test teardown of the fakes
  delete globalThis.window
  // @ts-expect-error test teardown of the fakes
  delete globalThis.localStorage
  // @ts-expect-error test teardown of the fakes
  delete globalThis.sessionStorage
})

const { useAgentMode } = await import('@/assets/js/store/agentMode')

type Store = ReturnType<typeof useAgentMode>

const wireRecord = (id: string) => ({
  id,
  workspaceDir: '/work',
  title: 'a session',
  createdAt: 1,
  updatedAt: 2,
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'build it' }] }],
})

describe('useAgentMode session hydration', () => {
  it('hydrates records and the active id from the kernel files', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({
      status: 'ok',
      activeSessionId: 'aipg-agent-1',
      sessions: [wireRecord('aipg-agent-1')],
    })
    const store: Store = useAgentMode()

    await store.init()

    expect(store.sessions['aipg-agent-1']).toMatchObject({ id: 'aipg-agent-1', title: 'a session' })
    expect(store.activeSessionId).toBe('aipg-agent-1')
    // restoreActiveSession put the record's transcript into the live chat.
    expect(store.chat.messages).toHaveLength(1)
    expect(agentModeApi.migrateSessions).not.toHaveBeenCalled()
    // init is idempotent — a second call does not re-hydrate.
    await store.init()
    expect(agentModeApi.bootstrapSessions).toHaveBeenCalledTimes(1)
  })

  it('does not adopt an active id whose record did not hydrate', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({
      status: 'ok',
      activeSessionId: 'aipg-agent-missing',
      sessions: [],
    })
    const store: Store = useAgentMode()

    await store.init()

    expect(store.activeSessionId).toBe('')
    expect(store.chat.messages).toEqual([])
  })

  it('migrates the legacy Pinia payload once and strips it from the key', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({ status: 'empty' })
    agentModeApi.migrateSessions.mockResolvedValue({
      status: 'ok',
      activeSessionId: 'aipg-agent-1',
      sessions: [wireRecord('aipg-agent-1')],
    })
    storage.set(
      'agentMode',
      JSON.stringify({
        workspaceDir: '/work',
        mcpServerIds: ['mcp-1'],
        sessions: { 'aipg-agent-1': wireRecord('aipg-agent-1') },
        activeSessionId: 'aipg-agent-1',
      }),
    )
    const store: Store = useAgentMode()

    await store.init()

    expect(agentModeApi.migrateSessions).toHaveBeenCalledTimes(1)
    expect(agentModeApi.migrateSessions.mock.calls[0][0].sessions).toHaveProperty('aipg-agent-1')
    const key = JSON.parse(storage.get('agentMode') ?? '{}') as Record<string, unknown>
    expect(key.sessions).toBeUndefined()
    expect(key.activeSessionId).toBeUndefined()
    // The workspace half slimmed its fields too; what the pinia pick still
    // owns is untouched.
    expect(key.workspaceDir).toBeUndefined()
    expect(key.mcpServerIds).toEqual(['mcp-1'])
  })

  it('migrates leftover when files own an empty index (stranded-records rescue)', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({
      status: 'ok',
      activeSessionId: null,
      sessions: [],
    })
    agentModeApi.migrateSessions.mockResolvedValue({
      status: 'ok',
      activeSessionId: 'aipg-agent-1',
      sessions: [wireRecord('aipg-agent-1')],
    })
    storage.set(
      'agentMode',
      JSON.stringify({ sessions: { 'aipg-agent-1': wireRecord('aipg-agent-1') } }),
    )
    const store: Store = useAgentMode()

    await store.init()

    expect(agentModeApi.migrateSessions).toHaveBeenCalledTimes(1)
    expect(store.sessions['aipg-agent-1']).toBeDefined()
  })

  it('keeps the legacy payload when the upload fails, so the next boot retries', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({ status: 'empty' })
    agentModeApi.migrateSessions.mockResolvedValue({ status: 'error', error: 'disk full' })
    storage.set(
      'agentMode',
      JSON.stringify({ sessions: { 'aipg-agent-1': wireRecord('aipg-agent-1') } }),
    )
    const store: Store = useAgentMode()

    await store.init()

    expect(agentModeApi.migrateSessions).toHaveBeenCalledTimes(1)
    const key = JSON.parse(storage.get('agentMode') ?? '{}') as Record<string, unknown>
    expect(key.sessions).toBeDefined()
  })

  it('drops a leftover empty legacy payload without migrating', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({ status: 'empty' })
    storage.set('agentMode', JSON.stringify({ sessions: {} }))
    const store: Store = useAgentMode()

    await store.init()

    expect(agentModeApi.migrateSessions).not.toHaveBeenCalled()
    const key = JSON.parse(storage.get('agentMode') ?? '{}') as Record<string, unknown>
    expect(key.sessions).toBeUndefined()
  })

  it('continues with an empty map when the file store does not answer', async () => {
    agentModeApi.bootstrapSessions.mockRejectedValue(new Error('ipc gone'))
    const store: Store = useAgentMode()

    await expect(store.init()).resolves.toBeUndefined()
    expect(Object.keys(store.sessions)).toHaveLength(0)
  })

  it('strips leftover sessions from the Pinia key when files already own them', async () => {
    storage.set(
      'agentMode',
      JSON.stringify({
        workspaceDir: '/work',
        mcpServerIds: ['mcp-1'],
        sessions: { stale: wireRecord('stale') },
        activeSessionId: 'stale',
      }),
    )
    agentModeApi.bootstrapSessions.mockResolvedValue({
      status: 'ok',
      activeSessionId: 'aipg-agent-1',
      sessions: [wireRecord('aipg-agent-1')],
    })
    const store: Store = useAgentMode()

    await store.init()

    expect(agentModeApi.migrateSessions).not.toHaveBeenCalled()
    expect(store.sessions['aipg-agent-1']).toBeDefined()
    const key = JSON.parse(storage.get('agentMode') ?? '{}') as Record<string, unknown>
    expect(key.sessions).toBeUndefined()
    expect(key.activeSessionId).toBeUndefined()
    // the workspace half slimmed its fields too; what the pinia pick still owns stays
    expect(key.workspaceDir).toBeUndefined()
    expect(key.mcpServerIds).toEqual(['mcp-1'])
  })
})

describe('useAgentMode session write-through', () => {
  async function hydratedStore(): Promise<Store> {
    agentModeApi.bootstrapSessions.mockResolvedValue({ status: 'empty' })
    const store: Store = useAgentMode()
    await store.init()
    agentModeApi.saveSession.mockClear()
    agentModeApi.saveActiveSessionId.mockClear()
    return store
  }

  it('does not write before init has hydrated', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({ status: 'empty' })
    const store: Store = useAgentMode()
    store.sessions = { 'aipg-agent-1': wireRecord('aipg-agent-1') as never }
    store.activeSessionId = 'aipg-agent-1'

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(agentModeApi.saveSession).not.toHaveBeenCalled()
    expect(agentModeApi.saveActiveSessionId).not.toHaveBeenCalled()
  })

  it('does not persist a map assignment; a turn-lifecycle rewrite does', async () => {
    const store = await hydratedStore()
    store.sessions = {
      'aipg-agent-1': { ...wireRecord('aipg-agent-1'), capabilities: ['media'] } as never,
    }
    store.activeSessionId = 'aipg-agent-1'
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(agentModeApi.saveSession).not.toHaveBeenCalled()

    store.setCapabilityEnabled('web-debug', true)
    await vi.waitFor(() => expect(agentModeApi.saveSession).toHaveBeenCalledTimes(1))
    const saved = agentModeApi.saveSession.mock.calls[0]?.[0] as {
      id: string
      capabilities?: string[]
    }
    expect(saved).toMatchObject({ id: 'aipg-agent-1' })
    expect(saved.capabilities).toContain('web-debug')
  })

  it('forwards an empty active id as null (the games preset has no open session)', async () => {
    const store = await hydratedStore()
    store.activeSessionId = 'aipg-agent-1'
    await vi.waitFor(() =>
      expect(agentModeApi.saveActiveSessionId).toHaveBeenCalledWith('aipg-agent-1'),
    )
    agentModeApi.saveActiveSessionId.mockClear()

    store.activeSessionId = ''
    await vi.waitFor(() => expect(agentModeApi.saveActiveSessionId).toHaveBeenCalledWith(null))
  })

  it('reports a failed persist reply without dropping the live copy', async () => {
    const store = await hydratedStore()
    store.sessions = {
      'aipg-agent-1': { ...wireRecord('aipg-agent-1'), capabilities: ['media'] } as never,
    }
    store.activeSessionId = 'aipg-agent-1'
    agentModeApi.saveSession.mockResolvedValueOnce({ success: false, error: 'disk full' })
    store.setCapabilityEnabled('web-debug', true)
    await vi.waitFor(() => expect(errorsReport).toHaveBeenCalled())
    expect(errorsReport.mock.calls[0][0]).toMatchObject({ message: 'disk full' })
    expect(store.sessions['aipg-agent-1']).toMatchObject({ id: 'aipg-agent-1' })
    expect(store.sessions['aipg-agent-1'].capabilities).toContain('web-debug')
  })

  it('keeps the row when the kernel refuses the delete', async () => {
    const store = await hydratedStore()
    store.sessions = { 'aipg-agent-1': wireRecord('aipg-agent-1') as never }
    agentModeApi.deleteSession.mockResolvedValueOnce({ success: false, error: 'disk full' })

    await store.deleteSession('aipg-agent-1')

    expect(store.sessions['aipg-agent-1']).toBeDefined()
    expect(errorsReport).toHaveBeenCalled()
  })

  it('drops the row only after the kernel confirms the delete', async () => {
    const store = await hydratedStore()
    store.sessions = { 'aipg-agent-1': wireRecord('aipg-agent-1') as never }
    agentModeApi.deleteSession.mockResolvedValueOnce({ success: true })

    await store.deleteSession('aipg-agent-1')

    expect(store.sessions['aipg-agent-1']).toBeUndefined()
  })
})

describe('useAgentMode workspace state', () => {
  it('hydrates the workspace pointers from the kernel file', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({ status: 'empty' })
    agentModeApi.readWorkspaceState.mockResolvedValueOnce({
      success: true,
      section: {
        workspaceDir: '/last/pick',
        lastWorkspaceByKind: { pick: '/last/pick', games: '/games' },
      },
    })
    const store: Store = useAgentMode()

    await store.init()

    expect(store.workspaceDir).toBe('/last/pick')
    expect(store.lastWorkspaceByKind).toEqual({ pick: '/last/pick', games: '/games' })
    expect(agentModeApi.migrateWorkspaceState).not.toHaveBeenCalled()
  })

  it('uploads the legacy workspace fields once, slims them out, then writes through', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({ status: 'empty' })
    storage.set(
      'agentMode',
      JSON.stringify({
        workspaceDir: '/legacy',
        lastWorkspaceByKind: { pick: '/legacy' },
        mcpServerIds: ['m'],
      }),
    )
    const store: Store = useAgentMode()

    await store.init()

    // the leftover hydrated (the file was absent) and the upload happened once
    expect(store.workspaceDir).toBe('/legacy')
    expect(agentModeApi.migrateWorkspaceState).toHaveBeenCalledWith({
      workspaceDir: '/legacy',
      lastWorkspaceByKind: { pick: '/legacy' },
    })
    expect(JSON.parse(storage.get('agentMode') ?? '{}')).toEqual({ mcpServerIds: ['m'] })

    store.workspaceDir = '/next'
    await vi.waitFor(() => expect(agentModeApi.writeWorkspaceState).toHaveBeenCalled())
    expect(agentModeApi.writeWorkspaceState).toHaveBeenCalledWith({
      workspaceDir: '/next',
      lastWorkspaceByKind: { pick: '/legacy' },
    })
  })

  it('does not overlay leftover when the workspace file is unreadable', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({ status: 'empty' })
    agentModeApi.readWorkspaceState.mockResolvedValueOnce({
      success: false,
      error: 'agent workspace file unreadable',
    })
    storage.set(
      'agentMode',
      JSON.stringify({
        workspaceDir: '/legacy',
        lastWorkspaceByKind: { pick: '/legacy' },
        mcpServerIds: ['m'],
      }),
    )
    const store: Store = useAgentMode()

    await store.init()

    expect(store.workspaceDir).toBe('')
    expect(store.lastWorkspaceByKind).toEqual({})
    expect(agentModeApi.migrateWorkspaceState).not.toHaveBeenCalled()
    expect(JSON.parse(storage.get('agentMode') ?? '{}')).toMatchObject({
      workspaceDir: '/legacy',
      lastWorkspaceByKind: { pick: '/legacy' },
      mcpServerIds: ['m'],
    })
    expect(errorsReport).toHaveBeenCalled()
    expect(
      errorsReport.mock.calls.some((call) => call[1]?.code === 'agent-workspace/read-failed'),
    ).toBe(true)
  })

  it('does not overlay leftover onto an existing workspace file', async () => {
    agentModeApi.bootstrapSessions.mockResolvedValue({ status: 'empty' })
    agentModeApi.readWorkspaceState.mockResolvedValueOnce({
      success: true,
      section: {
        workspaceDir: '/file',
        lastWorkspaceByKind: { pick: '/file', games: '/games' },
      },
    })
    storage.set(
      'agentMode',
      JSON.stringify({
        workspaceDir: '/legacy',
        lastWorkspaceByKind: { pick: '/legacy' },
        mcpServerIds: ['m'],
      }),
    )
    const store: Store = useAgentMode()

    await store.init()

    expect(store.workspaceDir).toBe('/file')
    expect(store.lastWorkspaceByKind).toEqual({ pick: '/file', games: '/games' })
    expect(agentModeApi.migrateWorkspaceState).not.toHaveBeenCalled()
    expect(JSON.parse(storage.get('agentMode') ?? '{}')).toMatchObject({
      workspaceDir: '/legacy',
      mcpServerIds: ['m'],
    })
  })
})
