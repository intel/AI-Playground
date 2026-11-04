import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'

// Session Settings for the Agent preset: each Agent Session keeps its own backend
// and model, a Draft Session starts from the Default Settings (the preset's saved
// bag), and the other presets keep sharing one bag per preset.

type Bag = Record<string, unknown>

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP', 'openVINO'],
  agentPreset: true,
  agentWorkspace: 'pick',
} as ChatPreset

const GAME_AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Game Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'games',
  agentCapabilities: ['game-studio'],
} as ChatPreset

const PRESETS = [AGENT, GAME_AGENT]
const activePreset = ref<ChatPreset>(AGENT)

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    presets: PRESETS,
    get activePresetWithVariant() {
      return activePreset.value
    },
  }),
}))

const presetSwitchingMock = vi.hoisted(() => ({ switchPreset: vi.fn() }))
vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => presetSwitchingMock,
}))

/**
 * Stands in for the chat settings store, honouring the same binding contract: the
 * active preset's live values load from the bound session (or the preset's bag when
 * the session has none, reporting what it loaded), and edits go to the session for
 * the Agent preset and to the preset's bag for every other preset.
 */
const chat = vi.hoisted(() => {
  type Binding = {
    load: (d: Bag, e: string) => Bag | null
    save: (b: Bag, e: string) => void
    pinned: () => boolean
    loaded: (b: Bag, e: string) => void
  }
  const state = {
    binding: null as Binding | null,
    live: {} as Bag,
    settingsPerPreset: {} as Record<string, Bag>,
    presetName: () => 'Agent',
    catalog: [] as { name: string; type: string }[],
  }
  const models = () => (state.live.selectedModels ?? {}) as Record<string, string | null>
  const current = (): Bag => JSON.parse(JSON.stringify(state.live))
  const apply = (bag: Bag) => {
    state.live = { backend: 'llamaCPP', ...JSON.parse(JSON.stringify(bag)) }
  }
  const sessionScoped = () => state.presetName() === 'Agent'
  return {
    state,
    store: {
      get backend() {
        return state.live.backend as string
      },
      get activeModel() {
        return models()[state.live.backend as string] ?? undefined
      },
      get settingsPerPreset() {
        return state.settingsPerPreset
      },
      set settingsPerPreset(next: Record<string, Bag>) {
        state.settingsPerPreset = next
      },
      ensureReadyForInference: async () => {},
      embeddingBackend: 'llamaCPP',
      get settingsAvailability() {
        return {
          models: state.catalog,
          embeddingModels: [],
          services: [],
          cloudEnabled: false,
          cloudProviderIds: [],
          embeddingBackend: 'llamaCPP',
        }
      },
      bindSessionSettings: (binding: Binding | null) => {
        state.binding = binding
      },
      loadSettingsForActivePreset: () => {
        const defaults = state.settingsPerPreset[state.presetName()] ?? {}
        const sessionBag = sessionScoped()
          ? (state.binding?.load(defaults, 'llamaCPP') ?? null)
          : null
        apply(sessionBag ?? defaults)
        // Stands in for a substitution made while loading (an unavailable value replaced).
        const model = models()[state.live.backend as string]
        const catalog = state.catalog.filter((m) => m.type === state.live.backend)
        if (model && catalog.length > 0 && !catalog.some((m) => m.name === model)) {
          state.live.selectedModels = {
            ...models(),
            [state.live.backend as string]: catalog[0].name,
          }
        }
        if (sessionBag && state.binding?.pinned()) {
          state.binding.loaded(current(), 'llamaCPP')
        }
        if (sessionScoped() && !sessionBag) state.binding?.save(current(), 'llamaCPP')
      },
    },
    edit(change: { backend?: string; model?: string } & Bag) {
      const { backend, model, ...rest } = change
      if (backend) state.live.backend = backend
      if (model !== undefined) {
        state.live.selectedModels = { ...models(), [state.live.backend as string]: model }
      }
      Object.assign(state.live, rest)
      const name = state.presetName()
      if (sessionScoped() && state.binding) {
        state.binding.save(current(), 'llamaCPP')
        return
      }
      state.settingsPerPreset[name] = { ...state.settingsPerPreset[name], ...current() }
    },
  }
})

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => chat.store,
  backendToAipgBackendName: { llamaCPP: 'llama_cpp', openVINO: 'openvino' },
}))

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({ checkModelAlreadyLoaded: vi.fn().mockResolvedValue([]) }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

const errorsReport = vi.hoisted(() => vi.fn())
vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReport }),
}))

const turnConfig = vi.hoisted(() => ({
  build: null as ((sessionId: string) => unknown) | null,
  lastInput: null as { planningThinkingOnly?: boolean } | null,
}))

vi.mock('@/assets/js/store/agentModeTurn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/assets/js/store/agentModeTurn')>()
  return {
    ...actual,
    buildTurnConfig: (input: { capabilities: string[]; planningThinkingOnly: boolean }) => {
      turnConfig.lastInput = input
      return { capabilities: input.capabilities }
    },
    createAgentTurnRuntimes: (options: { buildTurnConfig: (sessionId: string) => unknown }) => {
      turnConfig.build = options.buildTurnConfig
      return actual.createAgentTurnRuntimes(options as never)
    },
  }
})

vi.mock('@/assets/js/tools/agentBridge', () => ({
  getAgentToolSpecs: () => [],
}))

vi.mock('@ai-sdk/vue', () => ({
  Chat: class {
    messages: unknown[] = []
    error = undefined
    sendMessage = vi.fn(async function (this: { messages: unknown[] }, m: { text: string }) {
      this.messages = [
        ...this.messages,
        { id: `u${this.messages.length}`, role: 'user', parts: [{ type: 'text', text: m.text }] },
      ]
    })
    stop = vi.fn()
  },
}))

const saveSession = vi.fn(async (_record: { id: string; settings?: AgentSessionSettings }) => ({
  success: true,
}))

const ok = async () => ({ success: true as const })

let bootstrap: unknown = { status: 'empty' }

function fakeWindow(): void {
  const storage = new Map<string, string>()
  const shim = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }
  globalThis.localStorage = shim as unknown as Storage
  globalThis.sessionStorage = shim as unknown as Storage
  globalThis.window = {
    electronAPI: {
      agentMode: {
        cancel: vi.fn(async () => {}),
        onExecuteTool: vi.fn(),
        bootstrapSessions: vi.fn(async () => bootstrap),
        migrateSessions: vi.fn(),
        saveSession,
        saveActiveSessionId: vi.fn(ok),
        deleteSession: vi.fn(ok),
        readWorkspaceState: vi.fn(async () => ({
          success: true,
          section: { workspaceDir: '/work', lastWorkspaceByKind: { pick: '/work' } },
        })),
        migrateWorkspaceState: vi.fn(ok),
        writeWorkspaceState: vi.fn(ok),
      },
      getLocaleSettings: vi.fn(async () => ({ languageOverride: null })),
      games: { read: vi.fn(async () => null), list: vi.fn(async () => []) },
    },
  } as unknown as Window & typeof globalThis
}

const { useAgentMode } = await import('@/assets/js/store/agentMode')

beforeEach(() => {
  setActivePinia(createPinia())
  fakeWindow()
  vi.clearAllMocks()
  activePreset.value = AGENT
  presetSwitchingMock.switchPreset.mockImplementation(async (name: string) => {
    activePreset.value = PRESETS.find((p) => p.name === name) ?? AGENT
    chat.store.loadSettingsForActivePreset()
    return { success: true }
  })
  bootstrap = { status: 'empty' }
  chat.state.binding = null
  chat.state.catalog = []
  chat.state.presetName = () => activePreset.value.name
  chat.state.live = { backend: 'llamaCPP' }
  chat.state.settingsPerPreset = {
    Agent: { backend: 'llamaCPP', selectedModels: { llamaCPP: 'Default-9B' } },
  }
})

afterEach(() => {
  // @ts-expect-error test teardown of the fakes
  delete globalThis.window
})

async function startedStore() {
  const store = useAgentMode()
  await store.init()
  await store.newSession()
  return store
}

function savedSettings(id: string): AgentSessionSettings | undefined {
  const calls = saveSession.mock.calls.filter(([record]) => record.id === id)
  return calls.at(-1)?.[0].settings
}

const live = () => ({ backend: chat.store.backend, model: chat.store.activeModel })

describe('Agent Session Settings', () => {
  it('starts a Draft Session from the Default Settings', async () => {
    await startedStore()
    expect(live()).toEqual({ backend: 'llamaCPP', model: 'Default-9B' })
  })

  it('stores the settings with the transcript when the first turn ends', async () => {
    const store = await startedStore()
    chat.edit({ model: 'Picked-27B' })
    await store.generate('build it')

    expect(savedSettings(store.openSessionId)).toMatchObject({
      backend: 'llamaCPP',
      model: 'Picked-27B',
    })
  })

  it('writes nothing for a Draft Session left before its first turn', async () => {
    const store = await startedStore()
    chat.edit({ model: 'Picked-27B' })
    await store.newSession()

    expect(saveSession).not.toHaveBeenCalled()
  })

  it('keeps edits in one session out of the others and out of the defaults', async () => {
    const store = await startedStore()
    await store.generate('first')
    const first = store.openSessionId

    await store.newSession()
    chat.edit({ backend: 'openVINO', model: 'Phi-4' })
    await store.generate('second')
    const second = store.openSessionId

    expect(savedSettings(first)).toMatchObject({ backend: 'llamaCPP', model: 'Default-9B' })
    expect(savedSettings(second)).toMatchObject({ backend: 'openVINO', model: 'Phi-4' })
    expect(chat.state.settingsPerPreset.Agent).toMatchObject({
      backend: 'llamaCPP',
      selectedModels: { llamaCPP: 'Default-9B' },
    })
  })

  it("shows a session's own settings again when switching back to it", async () => {
    const store = await startedStore()
    chat.edit({ backend: 'openVINO', model: 'Phi-4' })
    await store.generate('first')
    const first = store.openSessionId

    await store.newSession()
    expect(live()).toEqual({ backend: 'llamaCPP', model: 'Default-9B' })

    await store.switchSession(first)
    expect(live()).toEqual({ backend: 'openVINO', model: 'Phi-4' })
  })

  it('does not change a session when the user edits after leaving it', async () => {
    const store = await startedStore()
    await store.generate('first')
    const first = store.openSessionId
    await store.newSession()
    chat.edit({ model: 'Other-4B' })

    expect(store.sessions[first].settings).toMatchObject({
      backend: 'llamaCPP',
      model: 'Default-9B',
    })
  })

  it('leaves Game Agent on its shared per-preset settings', async () => {
    const store = await startedStore()
    await presetSwitchingMock.switchPreset('Game Agent')
    chat.edit({ model: 'Coder-14B' })

    expect(chat.state.settingsPerPreset['Game Agent']).toMatchObject({
      selectedModels: { llamaCPP: 'Coder-14B' },
    })
    expect(store.sessions[store.openSessionId]?.settings).toBeUndefined()
  })

  it('keeps provider, context, thinking, embeddings and workflows per session', async () => {
    const store = await startedStore()
    chat.edit({
      cloudProviderId: 'zai',
      requestedContextSize: 65536,
      contextSizeEdited: true,
      thinkingEnabled: false,
      selectedEmbeddingModels: { llamaCPP: 'bge-small' },
      builtinToolPresetEnablement: { Flux: false },
    })
    await store.generate('first')
    const first = store.openSessionId

    await store.newSession()
    expect(chat.state.live.thinkingEnabled).toBeUndefined()

    await store.switchSession(first)
    expect(chat.state.live).toMatchObject({
      cloudProviderId: 'zai',
      requestedContextSize: 65536,
      contextSizeEdited: true,
      thinkingEnabled: false,
      selectedEmbeddingModels: { llamaCPP: 'bge-small' },
      builtinToolPresetEnablement: { Flux: false },
    })
    expect(savedSettings(first)).toMatchObject({
      cloudProviderId: 'zai',
      contextSize: 65536,
      thinkingEnabled: false,
      embeddingModel: 'bge-small',
      builtinToolPresetEnablement: { Flux: false },
    })
  })

  it('neither saves nor restores the device, which applies to every session', async () => {
    const store = await startedStore()
    chat.edit({ selectedDeviceId: 'NPU', selectedDeviceUuid: 'u-npu' })
    await store.generate('first')
    const first = store.openSessionId
    expect(savedSettings(first)?.device).toBeUndefined()

    await store.newSession()
    await store.switchSession(first)
    expect(chat.state.live.selectedDeviceId).toBeUndefined()
    expect(chat.state.live.selectedDeviceUuid).toBeUndefined()
  })

  it('leaves an earlier session alone when the next one changes its thinking', async () => {
    const store = await startedStore()
    chat.edit({ thinkingEnabled: true })
    await store.generate('first')
    const first = store.openSessionId

    await store.newSession()
    chat.edit({ thinkingEnabled: false })
    await store.generate('second')

    expect(savedSettings(first)).toMatchObject({ thinkingEnabled: true })
    expect(savedSettings(store.openSessionId)).toMatchObject({ thinkingEnabled: false })
  })

  it('starts a Draft Session with the default capabilities and planning flag', async () => {
    chat.state.settingsPerPreset.Agent = {
      ...chat.state.settingsPerPreset.Agent,
      agentCapabilities: ['web', 'mcp:blender'],
      agentPlanningThinkingOnly: false,
    }
    const store = await startedStore()

    expect(store.capabilities).toEqual(['web', 'mcp:blender'])
    expect(store.effectivePlanningThinkingOnly).toBe(false)
  })

  it('keeps a capability or planning change in its own session', async () => {
    const store = await startedStore()
    store.setCapabilityEnabled('mcp:blender', true)
    store.setPlanningThinkingOnly(false)
    await store.generate('first')
    const first = store.openSessionId

    await store.newSession()
    expect(store.isCapabilityEnabled('mcp:blender')).toBe(false)
    expect(store.effectivePlanningThinkingOnly).toBe(true)

    await store.switchSession(first)
    expect(store.isCapabilityEnabled('mcp:blender')).toBe(true)
    expect(store.effectivePlanningThinkingOnly).toBe(false)
    expect(savedSettings(first)).toMatchObject({ planningThinkingOnly: false })
    expect(savedSettings(first)?.capabilities).toContain('mcp:blender')
  })

  it('sends the session capabilities and planning flag with a turn', async () => {
    const store = await startedStore()
    store.setCapabilityEnabled('mcp:blender', true)
    store.setPlanningThinkingOnly(false)

    const config = turnConfig.build?.(store.openSessionId) as unknown as { capabilities: string[] }
    expect(config.capabilities).toContain('mcp:blender')
    expect(turnConfig.lastInput?.planningThinkingOnly).toBe(false)
  })

  it('moves the global defaults into the Default Settings once', async () => {
    const store = useAgentMode()
    store.defaultCapabilities = ['web', 'mcp:old']
    store.planningThinkingOnly = false
    await store.init()
    await store.newSession()

    expect(chat.state.settingsPerPreset.Agent).toMatchObject({
      agentCapabilities: ['web', 'mcp:old'],
      agentPlanningThinkingOnly: false,
    })

    store.defaultCapabilities = ['media']
    store.planningThinkingOnly = true
    await store.newSession()
    expect(chat.state.settingsPerPreset.Agent).toMatchObject({
      agentCapabilities: ['web', 'mcp:old'],
      agentPlanningThinkingOnly: false,
    })
  })

  it("reads an old record's top-level capabilities as its Session Settings", async () => {
    bootstrap = {
      status: 'ok',
      activeSessionId: 'aipg-agent-old',
      sessions: [
        {
          id: 'aipg-agent-old',
          workspaceDir: '/work',
          title: 'old',
          createdAt: 1,
          updatedAt: 2,
          presetName: 'Agent',
          capabilities: ['web', 'mcp:legacy'],
          messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        },
      ],
    }
    const store = useAgentMode()
    await store.init()

    expect(store.capabilities).toEqual(['web', 'mcp:legacy'])
    await store.generate('again')
    const saved = saveSession.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(saved.capabilities).toBeUndefined()
    expect(saved.settings).toMatchObject({ capabilities: ['web', 'mcp:legacy'] })
  })

  it('keeps Game Agent capabilities frozen on the record as before', async () => {
    const store = await startedStore()
    await presetSwitchingMock.switchPreset('Game Agent')
    expect(store.capabilities).toEqual(['game-studio'])
  })

  it('saves the session settings as the defaults without touching any record', async () => {
    const store = await startedStore()
    await store.generate('first')
    chat.edit({ backend: 'openVINO', model: 'Phi-4', thinkingEnabled: false })
    store.setCapabilityEnabled('mcp:blender', true)
    saveSession.mockClear()

    store.saveAsDefault()

    expect(saveSession).not.toHaveBeenCalled()
    expect(chat.state.settingsPerPreset.Agent).toMatchObject({
      backend: 'openVINO',
      selectedModels: { openVINO: 'Phi-4' },
      thinkingEnabled: false,
    })
    expect(chat.state.settingsPerPreset.Agent.agentCapabilities).toContain('mcp:blender')

    await store.newSession()
    expect(live()).toEqual({ backend: 'openVINO', model: 'Phi-4' })
    expect(store.isCapabilityEnabled('mcp:blender')).toBe(true)
  })

  it('keeps earlier sessions as they were after saving new defaults', async () => {
    const store = await startedStore()
    await store.generate('first')
    const first = store.openSessionId
    await store.newSession()
    chat.edit({ model: 'New-27B' })
    store.saveAsDefault()

    expect(store.sessions[first].settings).toMatchObject({ model: 'Default-9B' })
  })

  it('resets only the active session to the defaults', async () => {
    const store = await startedStore()
    await store.generate('first')
    const first = store.openSessionId
    await store.newSession()
    chat.edit({ model: 'Picked-27B' })
    store.setCapabilityEnabled('mcp:blender', true)
    await store.generate('second')
    const second = store.openSessionId
    saveSession.mockClear()

    store.resetToDefault()

    expect(live()).toEqual({ backend: 'llamaCPP', model: 'Default-9B' })
    expect(store.isCapabilityEnabled('mcp:blender')).toBe(false)
    expect(saveSession.mock.calls.map(([record]) => record.id)).toEqual([second])
    expect(savedSettings(second)).toMatchObject({ model: 'Default-9B' })
    expect(store.sessions[first].settings).toMatchObject({ model: 'Default-9B' })
  })

  it('resets a Draft Session in memory only', async () => {
    const store = await startedStore()
    chat.edit({ model: 'Picked-27B' })
    store.resetToDefault()

    expect(live()).toEqual({ backend: 'llamaCPP', model: 'Default-9B' })
    expect(saveSession).not.toHaveBeenCalled()
  })

  const oldRecord = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    workspaceDir: '/work',
    title: 'old',
    createdAt: 1,
    updatedAt: 2,
    presetName: 'Agent',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  })

  async function openedWith(record: Record<string, unknown>) {
    bootstrap = { status: 'ok', activeSessionId: record.id, sessions: [record] }
    const store = useAgentMode()
    await store.init()
    return store
  }

  it('fills a record saved without settings from the defaults and stores it once', async () => {
    chat.state.settingsPerPreset.Agent = {
      ...chat.state.settingsPerPreset.Agent,
      thinkingEnabled: false,
    }
    await openedWith(oldRecord('aipg-agent-old'))

    const saves = saveSession.mock.calls.filter(([r]) => r.id === 'aipg-agent-old')
    expect(saves).toHaveLength(1)
    expect(saves[0][0].settings).toMatchObject({
      backend: 'llamaCPP',
      model: 'Default-9B',
      thinkingEnabled: false,
    })
  })

  it('fills only the missing field and keeps what the session stored', async () => {
    chat.state.settingsPerPreset.Agent = {
      ...chat.state.settingsPerPreset.Agent,
      thinkingEnabled: false,
    }
    await openedWith(
      oldRecord('aipg-agent-old', { settings: { backend: 'llamaCPP', model: 'Own-4B' } }),
    )

    expect(savedSettings('aipg-agent-old')).toMatchObject({
      backend: 'llamaCPP',
      model: 'Own-4B',
      thinkingEnabled: false,
    })
  })

  it('stops following the defaults once filled', async () => {
    const store = await openedWith(oldRecord('aipg-agent-old'))
    chat.state.settingsPerPreset.Agent = {
      ...chat.state.settingsPerPreset.Agent,
      selectedModels: { llamaCPP: 'Changed-27B' },
    }
    await store.newSession()
    await store.switchSession('aipg-agent-old')

    expect(live()).toEqual({ backend: 'llamaCPP', model: 'Default-9B' })
  })

  it('does not rewrite a record that already has every field', async () => {
    await openedWith(
      oldRecord('aipg-agent-old', {
        settings: {
          backend: 'openVINO',
          model: 'Phi-4',
          capabilities: ['web'],
          planningThinkingOnly: true,
        },
      }),
    )
    expect(saveSession).not.toHaveBeenCalled()
  })

  it('leaves an unavailable-session placeholder alone', async () => {
    await openedWith(oldRecord('aipg-agent-gone', { title: 'Unavailable session', messages: [] }))
    expect(saveSession).not.toHaveBeenCalled()
  })

  describe('blocking on unusable stored settings', () => {
    const sentWithModel = (model: string) =>
      oldRecord('aipg-agent-sent', {
        settings: {
          backend: 'llamaCPP',
          model,
          capabilities: ['web'],
          planningThinkingOnly: true,
        },
      })

    it('refuses to send while the stored model is no longer in the catalog', async () => {
      chat.state.catalog = [{ name: 'Default-9B', type: 'llamaCPP' }]
      const store = await openedWith(sentWithModel('Gone-7B'))
      const sent = store.chat.messages.length

      await store.generate('go on')

      expect(store.settingsProblems).toEqual([{ field: 'model', value: 'Gone-7B' }])
      expect(store.chat.messages).toHaveLength(sent)
      expect(errorsReport).toHaveBeenCalledWith(
        expect.objectContaining({ surface: 'inline', code: 'agent/session-settings-unusable' }),
      )
    })

    it('does not let a substitution made while loading replace the stored value', async () => {
      chat.state.catalog = [{ name: 'Default-9B', type: 'llamaCPP' }]
      const store = await openedWith(sentWithModel('Gone-7B'))
      chat.edit({ thinkingEnabled: false })

      expect(store.sessions['aipg-agent-sent'].settings?.model ?? 'Gone-7B').toBe('Gone-7B')
      expect(store.settingsProblems.map((p) => p.field)).toEqual(['model'])
    })

    it('sends again once the user picks a usable model', async () => {
      chat.state.catalog = [
        { name: 'Default-9B', type: 'llamaCPP' },
        { name: 'Other-4B', type: 'llamaCPP' },
      ]
      const store = await openedWith(sentWithModel('Gone-7B'))
      chat.edit({ model: 'Other-4B' })

      expect(store.settingsProblems).toEqual([])
      const before = store.chat.messages.length
      await store.generate('go on')
      expect(store.chat.messages.length).toBe(before + 1)
    })

    it('takes the loaded model again when the user picks another one and then switches back', async () => {
      chat.state.catalog = [
        { name: 'Loaded-9B', type: 'llamaCPP' },
        { name: 'Missing-27B', type: 'llamaCPP' },
      ]
      const store = await openedWith(sentWithModel('Loaded-9B'))
      chat.edit({ model: 'Missing-27B' })
      expect(store.openSessionSettings.model).toBe('Missing-27B')

      chat.edit({ model: 'Loaded-9B' })

      expect(store.openSessionSettings.model).toBe('Loaded-9B')
      expect(store.sessions['aipg-agent-sent'].settings?.model).toBe('Loaded-9B')
    })

    it('never blocks a Draft Session', async () => {
      chat.state.catalog = [{ name: 'Other-4B', type: 'llamaCPP' }]
      const store = await startedStore()
      expect(store.settingsProblems).toEqual([])
    })
  })
})
