import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatPreset } from '@/assets/js/store/presets'

// Game Agent and Quick Coder inside a Session: the open Session decides which
// Harness Session each games preset shows and which game it works on, a second
// visit continues that game, and the Quick Coder hand-over stays in the Session.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'pick',
} as ChatPreset

const QUICK_CODER: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Quick Coder',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'games',
  agentCapabilities: ['game-studio-quick'],
} as ChatPreset

const GAME_AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Game Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'games',
  agentCapabilities: ['media', 'web-debug', 'game-studio'],
} as ChatPreset

const ASSISTANT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Assistant',
  backends: ['llamaCPP'],
} as ChatPreset

const PRESETS = [AGENT, QUICK_CODER, GAME_AGENT, ASSISTANT]
const activePreset = ref<ChatPreset>(GAME_AGENT)

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    presets: PRESETS,
    get activePresetWithVariant() {
      return activePreset.value
    },
  }),
}))

const switchPreset = vi.fn(async (name: string) => {
  const preset = PRESETS.find((entry) => entry.name === name)
  if (preset) activePreset.value = preset
  return { success: true }
})

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset }),
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    backend: 'llamaCPP',
    ensureReadyForInference: vi.fn(),
    bindSessionSettings: vi.fn(),
    loadSettingsForActivePreset: vi.fn(),
  }),
}))

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({ checkModelAlreadyLoaded: vi.fn().mockResolvedValue([]) }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

const report = vi.fn()
vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report }) }))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
}))

vi.mock('@/assets/js/tools/agentBridge', () => ({
  getAgentToolSpecs: () => [],
}))

vi.mock('@ai-sdk/vue', () => ({
  Chat: class {
    messages: Array<Record<string, unknown>> = []
    error = undefined
    status = 'ready'
    sendMessage = vi.fn(async ({ text }: { text: string }) => {
      this.messages = [
        ...this.messages,
        { id: `u-${text}`, role: 'user', parts: [{ type: 'text', text }] },
        { id: `a-${text}`, role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
      ]
    })
    stop = vi.fn()
  },
}))

type Harness = { harnessSessionId: string; workspaceDir: string }
type GameWorkspace = { kind: 'game'; gameDir?: string; fresh?: boolean }

/** What main keeps per (Session, preset): the Harness Session and its game folder. */
let harnesses: Record<string, Harness> = {}
let minted = 0
const harnessSession = vi.fn(
  async (sessionId: string, presetName: string, game?: GameWorkspace) => {
    const key = `${sessionId}/${presetName}`
    const existing = harnesses[key]
    if (!existing || game?.fresh) {
      harnesses[key] = {
        harnessSessionId: `aipg-agent-${++minted}`,
        workspaceDir: game ? (game.gameDir ?? '') : `/sessions/${sessionId}/files`,
      }
    } else if (game?.gameDir && !existing.workspaceDir) {
      harnesses[key] = { ...existing, workspaceDir: game.gameDir }
    }
    return { success: true as const, harness: harnesses[key] }
  },
)
const saveTimelineMessages = vi.fn(async () => ({ success: true as const }))
const agentCancel = vi.fn(async () => {})
let games: Record<string, { dir: string; name: string; description?: string }> = {}
let gameCount = 0
const createGame = vi.fn(async (prompt: string) => {
  const dir = `/games/game-${++gameCount}`
  games[dir] = { dir, name: prompt }
  return games[dir]
})
let dispatchTool: ((request: Record<string, unknown>) => void | Promise<void>) | undefined

globalThis.window = {
  electronAPI: {
    agentMode: {
      cancel: agentCancel,
      deleteSession: vi.fn(async () => ({ success: true })),
      saveSession: vi.fn(async () => ({ success: true })),
      saveActiveSessionId: vi.fn(async () => ({ success: true })),
      submitToolResult: vi.fn(async () => {}),
      onExecuteTool: vi.fn((handler) => {
        dispatchTool = handler
        return () => {}
      }),
    },
    sessions: { harnessSession, saveTimelineMessages },
    games: {
      read: vi.fn(async (dir: string) => games[dir] ?? null),
      list: vi.fn(async () => []),
      create: createGame,
    },
    existsPath: vi.fn(async () => true),
  },
} as unknown as Window & typeof globalThis

const { useAgentMode } = await import('@/assets/js/store/agentMode')
const { useSessions } = await import('@/assets/js/store/sessions')
const { useConfirmations } = await import('@/assets/js/store/confirmations')

type Store = ReturnType<typeof useAgentMode>

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function selectPreset(preset: ChatPreset): Promise<void> {
  activePreset.value = preset
  await settle()
  await settle()
}

async function openSessionRef(id: string): Promise<void> {
  useSessions().openSessionId = id
  await settle()
  await settle()
}

// One store for the file: the tool-call handler is registered once per module.
let store: Store

beforeAll(() => {
  setActivePinia(createPinia())
  store = useAgentMode()
  store.sessionsHydrated = true
})

beforeEach(async () => {
  harnesses = {}
  games = {}
  gameCount = 0
  harnessSession.mockClear()
  createGame.mockClear()
  switchPreset.mockClear()
  agentCancel.mockClear()
  report.mockClear()
  useSessions().openSessionId = null
  await selectPreset(GAME_AGENT)
})

describe('Game Agent and Quick Coder in a Session', () => {
  it('opens its Harness Session with no game until the first prompt', async () => {
    await openSessionRef('s1')

    expect(harnessSession).toHaveBeenLastCalledWith('s1', 'Game Agent', { kind: 'game' })
    expect(store.openSessionId).toBe(harnesses['s1/Game Agent'].harnessSessionId)
    expect(store.workspaceDir).toBe('')
  })

  it("mints the game on the first prompt and keeps it as the Harness Session's workspace", async () => {
    await openSessionRef('s1')

    await store.generate('a plum platformer')

    expect(createGame).toHaveBeenCalledTimes(1)
    expect(harnesses['s1/Game Agent'].workspaceDir).toBe('/games/game-1')
    expect(store.workspaceDir).toBe('/games/game-1')
    expect(store.sessions[store.openSessionId]).toMatchObject({
      sessionRef: 's1',
      workspaceDir: '/games/game-1',
      presetName: 'Game Agent',
    })
  })

  it('continues the same game after Image Gen or the Agent preset in between', async () => {
    await openSessionRef('s1')
    await store.generate('a plum platformer')
    const harnessId = store.openSessionId

    await selectPreset(ASSISTANT)
    await selectPreset(AGENT)
    await selectPreset(GAME_AGENT)

    expect(store.openSessionId).toBe(harnessId)
    expect(store.workspaceDir).toBe('/games/game-1')
    expect(store.messages).toHaveLength(2)
    await store.generate('make it faster')
    expect(createGame).toHaveBeenCalledTimes(1)
  })

  it('gives Quick Coder its own Harness Session and game in the same Session', async () => {
    await openSessionRef('s1')
    await store.generate('a plum platformer')
    const gameAgentHarness = store.openSessionId

    await selectPreset(QUICK_CODER)
    expect(store.openSessionId).not.toBe(gameAgentHarness)
    expect(store.workspaceDir).toBe('')
    await store.generate('one-shot snake')

    expect(store.workspaceDir).toBe('/games/game-2')
  })

  it('a new Session under Game Agent starts a new game', async () => {
    await openSessionRef('s1')
    await store.generate('a plum platformer')

    await openSessionRef('s2')

    expect(store.workspaceDir).toBe('')
    expect(store.messages).toHaveLength(0)
  })

  it("leaves a game's turn running when another Session is opened", async () => {
    await openSessionRef('s1')
    store.processing = true

    await openSessionRef('s2')

    expect(agentCancel).not.toHaveBeenCalled()
    store.processing = false
  })

  it('hands a Quick Coder game to Game Agent inside the same Session', async () => {
    await selectPreset(QUICK_CODER)
    await openSessionRef('s1')
    await store.generate('dodge asteroids')
    const quickHarness = store.openSessionId
    const confirmations = useConfirmations()

    store.processing = true
    const dispatched = dispatchTool?.({
      requestId: 'req-1',
      sessionId: quickHarness,
      toolCallId: 'call-1',
      toolName: 'offerGameAgent',
      input: { reason: 'add a boss', summary: 'Canvas shooter.' },
    })
    await vi.waitFor(() => expect(confirmations.items).toHaveLength(1))
    confirmations.resolve(confirmations.items[0].id, true)
    await dispatched
    store.processing = false
    await vi.waitFor(() => expect(store.openSessionId).not.toBe(quickHarness))
    await vi.waitFor(() => expect(store.messages.length).toBeGreaterThan(0))

    expect(switchPreset).toHaveBeenCalledWith('Game Agent', { skipMemoryAlert: true })
    expect(harnessSession).toHaveBeenCalledWith('s1', 'Game Agent', {
      kind: 'game',
      gameDir: '/games/game-1',
      fresh: true,
    })
    expect(useSessions().openSessionId).toBe('s1')
    expect(store.openSessionId).toBe(harnesses['s1/Game Agent'].harnessSessionId)
    expect(store.openSessionId).not.toBe(quickHarness)
    expect(store.workspaceDir).toBe('/games/game-1')
    expect(createGame).toHaveBeenCalledTimes(1)
    expect(store.sessions[quickHarness].presetName).toBe('Quick Coder')
  })
})
