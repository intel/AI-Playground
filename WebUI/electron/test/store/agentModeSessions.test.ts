import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatPreset } from '@/assets/js/store/presets'
import { takeLegacyPlanningThinkingOnly } from '@/assets/js/store/agentModeSessions'

// Agent Mode is entered through a chat preset (Agent, Game Agent), and a session
// belongs to the preset it was held with. These tests cover that association:
// which sessions the panel lists, what resuming one does, and what "new" means.
// Everything the store talks to besides the preset stores is stubbed away.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
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
  agentCapabilities: ['media', 'game-studio'],
} as ChatPreset

const activePreset = ref<ChatPreset>(AGENT)

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    presets: [AGENT, GAME_AGENT],
    get activePresetWithVariant() {
      return activePreset.value
    },
  }),
}))

// The real switch is what makes the preset active, and everything else in the
// store follows from that — so the stub does exactly that much.
const switchPreset = vi.fn(async (name: string) => {
  const preset = [AGENT, GAME_AGENT].find((entry) => entry.name === name)
  if (preset) activePreset.value = preset
  return { success: true }
})

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset }),
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({ backend: 'llamaCPP', ensureReadyForInference: vi.fn() }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: vi.fn() }),
}))

vi.mock('@/assets/js/tools/agentBridge', () => ({
  executeAgentTool: vi.fn(),
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

const gamesRead = vi.fn(async () => null)
const gamesCreate = vi.fn(async () => ({ dir: '/games/new-game' }))
const gamesList = vi.fn(async () => [{ dir: '/games/space-dodger' }])

// Only what these tests actually reach, hence the cast.
globalThis.window = {
  electronAPI: {
    agentMode: {
      cancel: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => ({ success: true })),
      onStreamChunk: vi.fn(),
      onToolProgress: vi.fn(),
      onToolImage: vi.fn(),
      onTurnDone: vi.fn(),
      onExecuteTool: vi.fn(),
    },
    games: { read: gamesRead, create: gamesCreate, list: gamesList },
  },
} as unknown as Window & typeof globalThis

const { useAgentMode } = await import('@/assets/js/store/agentMode')

type Store = ReturnType<typeof useAgentMode>

function seedSessions(store: Store): void {
  store.sessions = {
    'agent-1': {
      id: 'agent-1',
      workspaceDir: '/code/project',
      title: 'refactor the parser',
      messages: [],
      createdAt: 1,
      updatedAt: 3,
      presetName: 'Agent',
    },
    'game-1': {
      id: 'game-1',
      workspaceDir: '/games/space-dodger',
      title: 'a game where I dodge asteroids',
      messages: [{ id: 'm1', role: 'user', parts: [] }],
      createdAt: 1,
      updatedAt: 2,
      presetName: 'Game Agent',
    },
    legacy: {
      id: 'legacy',
      workspaceDir: '/code/older',
      title: 'from before presets',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    },
  }
}

/** Let the store's watchers (workspace kind, session id) run. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('agentMode sessions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    activePreset.value = AGENT
    switchPreset.mockClear()
    gamesRead.mockClear()
    gamesList.mockClear()
  })

  it('lists the active preset’s sessions, plus those archived before presets', async () => {
    const store = useAgentMode()
    seedSessions(store)

    expect(store.presetSessions.map((session) => session.id)).toEqual(['agent-1', 'legacy'])

    activePreset.value = GAME_AGENT
    await flush()
    expect(store.presetSessions.map((session) => session.id)).toEqual(['game-1', 'legacy'])
  })

  it('resuming a session goes back to the preset it was held with', async () => {
    const store = useAgentMode()
    seedSessions(store)

    await store.switchSession('game-1')
    await flush()

    expect(switchPreset).toHaveBeenCalledWith('Game Agent')
    expect(store.activeSessionId).toBe('game-1')
    // The preset switch changes how the workspace is chosen, which is exactly
    // when the folder must NOT be re-derived: it belongs to the session.
    expect(store.workspaceDir).toBe('/games/space-dodger')
    expect(store.chat.messages).toHaveLength(1)
  })

  it('leaves the preset alone for a session that names none', async () => {
    const store = useAgentMode()
    seedSessions(store)

    await store.switchSession('legacy')

    expect(switchPreset).not.toHaveBeenCalled()
    expect(store.workspaceDir).toBe('/code/older')
  })

  // Everything archived before sessions recorded a preset would otherwise show
  // up under every preset, forever.
  it('assigns older sessions the preset their folder implies', async () => {
    const store = useAgentMode()
    store.sessions = {
      game: {
        id: 'game',
        workspaceDir: '/games/space-dodger',
        title: 'a game',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      },
      code: {
        id: 'code',
        workspaceDir: '/code/project',
        title: 'some code',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      },
    }

    await store.migrateSessionPresets()

    expect(store.sessions.game.presetName).toBe('Game Agent')
    expect(store.sessions.code.presetName).toBe('Agent')
    expect(store.presetSessions.map((session) => session.id)).toEqual(['code'])
  })

  // A preset's name is its identity, so a session naming a preset that has since
  // been renamed would be listed under no preset at all.
  it('follows a session whose preset has been renamed', async () => {
    const store = useAgentMode()
    store.sessions = {
      game: {
        id: 'game',
        workspaceDir: '/games/space-dodger',
        title: 'a game',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        presetName: 'Game Maker',
      },
    }

    await store.migrateSessionPresets()

    expect(store.sessions.game.presetName).toBe('Game Agent')
    // No sessions predate `presetName`, so the folder listing is not needed.
    expect(gamesList).not.toHaveBeenCalled()

    activePreset.value = GAME_AGENT
    await flush()
    expect(store.presetSessions.map((session) => session.id)).toEqual(['game'])
  })

  it('starts a new game under Game Agent and a new conversation otherwise', async () => {
    const store = useAgentMode()
    seedSessions(store)
    await store.switchSession('agent-1')

    await store.startNew()
    // Same workspace, fresh conversation.
    expect(store.workspaceDir).toBe('/code/project')
    expect(store.activeSessionId).not.toBe('agent-1')

    activePreset.value = GAME_AGENT
    await flush()
    await store.startNew()
    // No folder yet: the first turn mints one named after the request.
    expect(store.workspaceDir).toBe('')
    expect(store.activeSessionId).toBe('')
  })
})

describe('takeLegacyPlanningThinkingOnly', () => {
  it('prefers the active agent preset’s saved value and strips the key', () => {
    const { value, bags } = takeLegacyPlanningThinkingOnly(
      {
        Agent: { thinkingEnabled: true, planningThinkingOnly: false },
        'Game Agent': { planningThinkingOnly: true },
      },
      'Agent',
    )
    expect(value).toBe(false)
    expect(bags.Agent).toEqual({ thinkingEnabled: true })
    expect(bags['Game Agent']).toEqual({})
  })

  it('leaves bags untouched when the key was never stored', () => {
    const original = { Agent: { thinkingEnabled: true } }
    const { value, bags } = takeLegacyPlanningThinkingOnly(original, 'Agent')
    expect(value).toBeUndefined()
    expect(bags).toBe(original)
  })
})
