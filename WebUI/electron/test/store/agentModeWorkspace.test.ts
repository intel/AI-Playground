import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatPreset } from '@/assets/js/store/presets'

// One `workspaceDir` is persisted for two unrelated kinds of workspace: a folder
// the user picked for the Agent preset, and a game folder the app minted under the
// library for Game Agent. These tests cover keeping them apart — Game Agent must
// never build into a picked folder, where it lands outside the library and leaves
// the game bar with no card to act on — and attaching files to an agent turn.

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
} as ChatPreset

const GAME_AGENT_QUICK: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Quick Coder',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'games',
  agentCapabilities: ['game-studio-quick'],
} as ChatPreset

const activePreset = ref<ChatPreset>(AGENT)

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    presets: [AGENT, GAME_AGENT, GAME_AGENT_QUICK],
    get activePresetWithVariant() {
      return activePreset.value
    },
  }),
}))

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset: vi.fn(async () => ({ success: true })) }),
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    backend: 'llamaCPP',
    activeModel: 'Qwen3.8-27B-Q4_K_M.gguf',
    ensureReadyForInference: vi.fn(),
  }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

const report = vi.fn()
vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report }) }))

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

/** Folders that hold a `game.json`, i.e. that `games.read` answers for. */
const gameFolders = new Set<string>(['/games/space-dodger'])

const gamesRead = vi.fn(async (dir: string) =>
  gameFolders.has(dir) ? { dir, name: 'Space Dodger' } : null,
)
const gamesCreate = vi.fn(async (_name: string, _options?: { scaffold?: boolean }) => {
  gameFolders.add('/games/new-game')
  return { dir: '/games/new-game', name: 'New game' }
})
const importAttachment = vi.fn(async (_dir: string, name: string) => ({
  success: true,
  path: `attachments/${name}`,
}))

// Only what these tests actually reach, hence the cast.
globalThis.window = {
  electronAPI: {
    agentMode: {
      cancel: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => ({ success: true })),
      importAttachment,
      onStreamChunk: vi.fn(),
      onToolProgress: vi.fn(),
      onToolImage: vi.fn(),
      onTurnDone: vi.fn(),
      onExecuteTool: vi.fn(),
    },
    games: { read: gamesRead, create: gamesCreate, list: vi.fn(async () => []) },
  },
} as unknown as Window & typeof globalThis

const { useAgentMode } = await import('@/assets/js/store/agentMode')

/** Let the store's watchers (workspace kind, session id) run. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('agentMode workspace kinds', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    activePreset.value = AGENT
    gameFolders.clear()
    gameFolders.add('/games/space-dodger')
    gamesCreate.mockClear()
    importAttachment.mockClear()
    report.mockClear()
  })

  it('mints a game rather than building into the Agent preset’s folder', async () => {
    const store = useAgentMode()
    activePreset.value = GAME_AGENT
    await flush()
    // What a restart used to hand Game Agent: the folder picked for Agent.
    store.workspaceDir = '/code/project'

    await store.generate('a game where I dodge asteroids')

    expect(gamesCreate).toHaveBeenCalledWith(
      'a game where I dodge asteroids',
      expect.objectContaining({ scaffold: true }),
    )
    expect(store.workspaceDir).toBe('/games/new-game')
    expect(store.currentGame?.dir).toBe('/games/new-game')
  })

  // The card is the only record of how a game was made: the turn that mints it is
  // the one moment the app still knows what it was started on.
  it('records what the game is being built with', async () => {
    const store = useAgentMode()
    activePreset.value = GAME_AGENT
    await flush()

    await store.generate('a game where I dodge asteroids')

    expect(gamesCreate).toHaveBeenCalledWith(
      'a game where I dodge asteroids',
      expect.objectContaining({
        backend: 'llamaCPP',
        startingModel: 'Qwen3.8-27B-Q4_K_M.gguf',
        initialPrompt: 'a game where I dodge asteroids',
      }),
    )
  })

  // The one-shot preset writes the whole page itself, so a scaffolded page would
  // be a file it has to work around.
  it('mints an empty folder for the preset that writes the game in one go', async () => {
    const store = useAgentMode()
    activePreset.value = GAME_AGENT_QUICK
    await flush()

    await store.generate('a game where I dodge asteroids')

    expect(gamesCreate).toHaveBeenCalledWith(
      'a game where I dodge asteroids',
      expect.objectContaining({ scaffold: false }),
    )
  })

  it('keeps working in a folder that is already a game', async () => {
    const store = useAgentMode()
    activePreset.value = GAME_AGENT
    await flush()
    store.workspaceDir = '/games/space-dodger'

    await store.generate('add a high score')

    expect(gamesCreate).not.toHaveBeenCalled()
    expect(store.workspaceDir).toBe('/games/space-dodger')
  })

  // The persisted workspace is hydrated after the store is built, so this is the
  // path a launch actually takes.
  it('hands a hydrated non-game folder back to the Agent preset', async () => {
    const store = useAgentMode()
    activePreset.value = GAME_AGENT
    await flush()
    store.workspaceDir = '/code/project'
    store.lastWorkspaceByKind = { games: '/games/space-dodger' }

    await store.reconcileWorkspaceKind()

    expect(store.workspaceDir).toBe('/games/space-dodger')
    expect(store.lastWorkspaceByKind.pick).toBe('/code/project')
  })

  it('leaves the Agent preset’s own folder alone', async () => {
    const store = useAgentMode()
    store.workspaceDir = '/code/project'

    await store.reconcileWorkspaceKind()

    expect(store.workspaceDir).toBe('/code/project')
  })

  // "New game" clears the workspace on purpose; restoring the last game over it
  // would resurrect the game the user just stepped away from.
  it('does not restore a game over a deliberately empty workspace', async () => {
    const store = useAgentMode()
    activePreset.value = GAME_AGENT
    await flush()
    store.lastWorkspaceByKind = { games: '/games/space-dodger' }
    store.workspaceDir = ''

    await store.reconcileWorkspaceKind()

    expect(store.workspaceDir).toBe('')
  })
})

describe('agentMode attachments', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    activePreset.value = AGENT
    gameFolders.clear()
    gameFolders.add('/games/space-dodger')
    gamesCreate.mockClear()
    importAttachment.mockClear()
    report.mockClear()
  })

  function file(name: string, body = 'x'): File {
    return new File([body], name, { type: 'image/png' })
  }

  // `@path` is how a file is referenced in a prompt throughout Pi, and every file
  // tool strips the prefix when resolving it.
  it('saves attachments into the workspace and references them the way Pi does', async () => {
    const store = useAgentMode()
    store.workspaceDir = '/code/project'

    await store.attachFiles([file('player.png'), file('notes.txt')])
    expect(store.attachments.map((a) => a.name)).toEqual(['player.png', 'notes.txt'])

    await store.generate('use these')

    expect(importAttachment).toHaveBeenCalledTimes(2)
    expect(importAttachment.mock.calls[0][0]).toBe('/code/project')
    const sent = (store.chat.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.text).toContain('use these')
    expect(sent.text).toContain('@attachments/player.png')
    expect(sent.text).toContain('@attachments/notes.txt')
    // Already in the workspace, so the next turn must not copy them again.
    expect(store.attachments).toEqual([])
  })

  it('quotes a reference whose path contains spaces', async () => {
    const store = useAgentMode()
    store.workspaceDir = '/code/project'

    await store.attachFiles([file('my ship.png')])
    await store.generate('use this')

    const sent = (store.chat.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.text).toContain('@"attachments/my ship.png"')
  })

  // The folder does not exist until the first prompt names the game, so the files
  // have to wait for it.
  it('waits for the game folder Game Agent mints from the first prompt', async () => {
    const store = useAgentMode()
    activePreset.value = GAME_AGENT
    await flush()

    await store.attachFiles([file('ship.png')])
    await store.generate('a game with this ship')

    expect(importAttachment).toHaveBeenCalledWith('/games/new-game', 'ship.png', expect.anything())
  })

  it('reports a failed attachment and sends the turn without it', async () => {
    const store = useAgentMode()
    store.workspaceDir = '/code/project'
    importAttachment.mockResolvedValueOnce({ success: false, error: 'disk full' } as never)

    await store.attachFiles([file('player.png')])
    await store.generate('use this')

    expect(report).toHaveBeenCalled()
    const sent = (store.chat.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.text).toBe('use this')
    expect(store.attachments).toEqual([])
  })

  it('drops an attachment the user removes again', async () => {
    const store = useAgentMode()
    await store.attachFiles([file('a.png'), file('b.png')])

    store.removeAttachment(0)

    expect(store.attachments.map((a) => a.name)).toEqual(['b.png'])
  })
})
