import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatPreset } from '@/assets/js/store/presets'

// A session's capabilities are frozen on its record while its instructions are
// read live off the active preset, so a session carried across a preset switch
// runs the new preset's prompt against the old preset's toolbox. These tests
// cover the rule that follows: switching agent preset always starts a blank
// session, and old ones are only reopened deliberately from the panel.

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
  agentCapabilities: ['media', 'web-debug', 'game-studio'],
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

/** Not an agent preset, so `agentPresetName` must not follow it. */
const ASSISTANT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Assistant',
  backends: ['llamaCPP'],
} as ChatPreset

const PRESETS = [AGENT, GAME_AGENT, QUICK_CODER, ASSISTANT]
const activePreset = ref<ChatPreset>(QUICK_CODER)

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
  useTextInference: () => ({ backend: 'llamaCPP', ensureReadyForInference: vi.fn() }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: vi.fn() }) }))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
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

const SPACE_DODGER = { dir: '/games/space-dodger', name: 'Space Dodger' }

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
    games: {
      read: vi.fn(async (dir: string) => (dir === SPACE_DODGER.dir ? SPACE_DODGER : null)),
      list: vi.fn(async () => []),
    },
  },
} as unknown as Window & typeof globalThis

const { useAgentMode } = await import('@/assets/js/store/agentMode')

type Store = ReturnType<typeof useAgentMode>

/** A message, so the session has a transcript worth archiving. */
function transcript(text: string) {
  return [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }]
}

/** Select `preset` the way the preset list does, and let the store settle. */
async function selectPreset(store: Store, preset: ChatPreset): Promise<void> {
  activePreset.value = preset
  await vi.waitFor(() => expect(store.activeAgentPreset?.name).not.toBe(undefined))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function seedGameSession(store: Store, presetName: string): void {
  store.sessions = {
    'qc-1': {
      id: 'qc-1',
      workspaceDir: SPACE_DODGER.dir,
      title: 'dodge asteroids',
      messages: transcript('dodge asteroids') as never,
      createdAt: 1,
      updatedAt: 2,
      presetName,
      capabilities: ['game-studio-quick'],
    },
  }
  store.activeSessionId = 'qc-1'
  store.workspaceDir = SPACE_DODGER.dir
  store.currentGame = SPACE_DODGER as never
  store.chat.messages = transcript('dodge asteroids') as never
}

describe('switching agent preset', () => {
  let store: Store

  beforeEach(async () => {
    setActivePinia(createPinia())
    activePreset.value = QUICK_CODER
    switchPreset.mockClear()
    store = useAgentMode()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('leaves the game behind when the user picks the other games preset', async () => {
    seedGameSession(store, 'Quick Coder')

    await selectPreset(store, GAME_AGENT)

    expect(store.workspaceDir).toBe('')
    expect(store.activeSessionId).toBe('')
    expect(store.chat.messages).toEqual([])
    expect(store.currentGame).toBe(null)
    // The one-shot run stays in the panel, under the preset that held it.
    expect(store.sessions['qc-1'].presetName).toBe('Quick Coder')
    expect(store.sessions['qc-1'].messages).toHaveLength(1)
  })

  // A session whose first turn is still running has no record yet, so the
  // snapshot is the only thing deciding which preset it is filed under.
  it('files a turn that was still running under the preset that held it', async () => {
    store.activeSessionId = 'live-1'
    store.workspaceDir = SPACE_DODGER.dir
    store.chat.messages = transcript('a game where I dodge asteroids') as never
    store.processing = true

    await selectPreset(store, GAME_AGENT)

    expect(store.sessions['live-1'].presetName).toBe('Quick Coder')
    expect(store.sessions['live-1'].workspaceDir).toBe(SPACE_DODGER.dir)
  })

  // The old workspace-kind reset reopened whichever session touched the games
  // folder last, whatever preset was holding it.
  it('does not adopt the latest game session when coming from the Agent preset', async () => {
    await selectPreset(store, AGENT)
    store.workspaceDir = '/code/project'
    store.sessions = {
      'qc-1': {
        id: 'qc-1',
        workspaceDir: SPACE_DODGER.dir,
        title: 'dodge asteroids',
        messages: transcript('dodge asteroids') as never,
        createdAt: 1,
        updatedAt: Date.now(),
        presetName: 'Quick Coder',
        capabilities: ['game-studio-quick'],
      },
    }

    await selectPreset(store, GAME_AGENT)

    expect(store.workspaceDir).toBe('')
    expect(store.activeSessionId).toBe('')
  })

  it('lands on the last picked folder when going back to the Agent preset', async () => {
    seedGameSession(store, 'Quick Coder')
    store.lastWorkspaceByKind = { pick: '/code/project' }

    await selectPreset(store, AGENT)

    expect(store.workspaceDir).toBe('/code/project')
    expect(store.activeSessionId).not.toBe('qc-1')
    expect(store.activeSessionId).not.toBe('')
    expect(store.chat.messages).toEqual([])
  })

  // `agentPresetName` follows agent presets only, which is what keeps the
  // image-gen preset a `media` call borrows mid-turn from ending the session.
  it('ignores a non-agent preset in between', async () => {
    seedGameSession(store, 'Quick Coder')

    await selectPreset(store, ASSISTANT)
    activePreset.value = QUICK_CODER
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.workspaceDir).toBe(SPACE_DODGER.dir)
    expect(store.activeSessionId).toBe('qc-1')
    expect(store.chat.messages).toHaveLength(1)
  })

  it('keeps the session resumed from the panel under its own preset', async () => {
    await selectPreset(store, GAME_AGENT)
    store.sessions = {
      'qc-1': {
        id: 'qc-1',
        workspaceDir: SPACE_DODGER.dir,
        title: 'dodge asteroids',
        messages: transcript('dodge asteroids') as never,
        createdAt: 1,
        updatedAt: 2,
        presetName: 'Quick Coder',
        capabilities: ['game-studio-quick'],
      },
    }

    await store.switchSession('qc-1')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(switchPreset).toHaveBeenCalledWith('Quick Coder')
    expect(store.activeSessionId).toBe('qc-1')
    expect(store.workspaceDir).toBe(SPACE_DODGER.dir)
    expect(store.chat.messages).toHaveLength(1)
  })
})
