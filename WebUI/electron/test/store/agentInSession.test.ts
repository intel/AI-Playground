import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatPreset } from '@/assets/js/store/presets'

// The Agent preset inside a Session: the open Session decides which Harness
// Session Agent Mode shows and where it works, switching presets returns to
// the same one, and its turns are saved into the Session's timeline.

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

const ASSISTANT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Assistant',
  backends: ['llamaCPP'],
} as ChatPreset

const PRESETS = [AGENT, GAME_AGENT, ASSISTANT]
const activePreset = ref<ChatPreset>(AGENT)

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    presets: PRESETS,
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

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: vi.fn() }) }))

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

const harnessSession = vi.fn(async (sessionId: string, presetName: string) => ({
  success: true as const,
  harness: {
    harnessSessionId: `aipg-agent-${sessionId}-${presetName}`,
    workspaceDir: `/sessions/${sessionId}/files`,
  },
}))
const saveTimelineMessages = vi.fn(async () => ({ success: true as const }))
const agentCancel = vi.fn(async () => {})

globalThis.window = {
  electronAPI: {
    agentMode: {
      cancel: agentCancel,
      deleteSession: vi.fn(async () => ({ success: true })),
      saveSession: vi.fn(async () => ({ success: true })),
      saveActiveSessionId: vi.fn(async () => ({ success: true })),
      onExecuteTool: vi.fn(),
    },
    sessions: { harnessSession, saveTimelineMessages },
    games: { read: vi.fn(async () => null), list: vi.fn(async () => []) },
    existsPath: vi.fn(async () => true),
  },
} as unknown as Window & typeof globalThis

const { useAgentMode } = await import('@/assets/js/store/agentMode')
const { useSessions } = await import('@/assets/js/store/sessions')

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

describe('the Agent preset in a Session', () => {
  let store: Store

  beforeEach(async () => {
    setActivePinia(createPinia())
    activePreset.value = AGENT
    harnessSession.mockClear()
    saveTimelineMessages.mockClear()
    agentCancel.mockClear()
    store = useAgentMode()
    store.sessionsHydrated = true
    await settle()
  })

  it("opens the Session's Harness Session, working in the Session's files folder", async () => {
    await openSessionRef('s1')

    expect(harnessSession).toHaveBeenCalledWith('s1', 'Agent')
    expect(store.openSessionId).toBe('aipg-agent-s1-Agent')
    expect(store.workspaceDir).toBe('/sessions/s1/files')
  })

  it('returns to the same Harness Session after another preset in between', async () => {
    await openSessionRef('s1')
    await store.generate('remember plum')
    expect(store.messages).toHaveLength(2)

    await selectPreset(ASSISTANT)
    await selectPreset(AGENT)

    expect(store.openSessionId).toBe('aipg-agent-s1-Agent')
    expect(store.messages.map((message) => message.id)).toEqual([
      'u-remember plum',
      'a-remember plum',
    ])
  })

  it('does not blank the Session when switching agent presets and back', async () => {
    await openSessionRef('s1')
    await store.generate('remember plum')

    await selectPreset(GAME_AGENT)
    await selectPreset(AGENT)

    expect(store.openSessionId).toBe('aipg-agent-s1-Agent')
    expect(store.workspaceDir).toBe('/sessions/s1/files')
    expect(store.messages).toHaveLength(2)
  })

  it("opens the other Session's Harness Session without stopping the turn it leaves", async () => {
    await openSessionRef('s1')
    store.processing = true

    await openSessionRef('s2')

    expect(store.openSessionId).toBe('aipg-agent-s2-Agent')
    expect(store.workspaceDir).toBe('/sessions/s2/files')
    expect(agentCancel).not.toHaveBeenCalled()
  })

  it("saves the turn's display messages into the Session timeline, tagged with its agent", async () => {
    await openSessionRef('s1')

    await store.generate('build a page')

    expect(saveTimelineMessages).toHaveBeenLastCalledWith('s1', [
      expect.objectContaining({
        id: 'u-build a page',
        metadata: { agentTurn: { presetName: 'Agent', harnessSessionId: 'aipg-agent-s1-Agent' } },
      }),
      expect.objectContaining({ id: 'a-build a page', role: 'assistant' }),
    ])
    expect(useSessions().openTimeline).toHaveLength(2)
  })

  it("keeps the Agent preset's settings in the Session, not on the Harness Session's record", async () => {
    const held: Record<string, { settings: Record<string, unknown>; sent: boolean }> = {}
    store.bindSessionSettingsPort({
      read: (preset) => held[preset],
      write: (preset, settings, sent) => {
        held[preset] = { settings, sent }
      },
      drop: (preset) => delete held[preset],
      readStored: async () => null,
      whenLoaded: async () => {},
    })
    await openSessionRef('s1')
    store.setCapabilities(['files'])
    expect(held.Agent).toEqual({ settings: { capabilities: ['files'] }, sent: false })

    await store.generate('build a page')

    expect(held.Agent.sent).toBe(true)
    expect(held.Agent.settings.capabilities).toEqual(['files'])
    expect(store.sessions['aipg-agent-s1-Agent'].settings).toBeUndefined()
  })

  it('records the Session on the Harness Session it belongs to', async () => {
    await openSessionRef('s1')

    await store.generate('build a page')

    expect(store.sessions['aipg-agent-s1-Agent']).toMatchObject({
      sessionRef: 's1',
      workspaceDir: '/sessions/s1/files',
      presetName: 'Agent',
    })
  })
})
