import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { AgentTask, AgentTaskSchedule } from '@/types/agentTaskIpc'
import type { KernelEvent, KernelSnapshot, PauseReason } from '@/types/kernelEvents'

// Scheduled Runs: the Tasks store's ticker starts a Task Run by itself when a
// Task's Next Run arrives, skips slots that find a run in flight or that were
// missed, and moves the Next Run on either way. Driven through the Tasks store
// against the real Agent store, with a fake electronAPI and a fake clock.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'pick',
  systemPrompt: 'You are the agent.',
} as ChatPreset

const IMAGE_GEN = { type: 'comfy', category: 'create-images', name: 'Flux' }

const activePreset = vi.hoisted(() => ({
  state: null as { preset: unknown } | null,
  /** The presets read on this machine; the Agent preset is absent while switched off. */
  list: [] as unknown[],
}))

vi.mock('@/assets/js/store/presets', async () => {
  const { reactive } = await import('vue')
  activePreset.state = reactive({ preset: AGENT as unknown })
  const state = activePreset.state
  return {
    usePresets: () => ({
      get presets() {
        return activePreset.list
      },
      get activePresetWithVariant() {
        return state.preset
      },
    }),
  }
})

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset: vi.fn(async () => ({ success: true })) }),
}))

const inference = vi.hoisted(() => ({
  samplingRequestBody: {},
  temperature: 0.7,
  modelSupportsThinkingToggle: false,
  thinkingEnabled: false,
  thinkingActive: false,
  localBackendUrl: 'http://127.0.0.1:39100',
  modelSupportsVision: false,
  effectiveContextWindow: 8192,
  getCurrentDeviceId: () => '0',
  getCurrentDeviceName: () => 'Arc B580',
  activeLlmModel: null,
  embeddingBackend: 'llamaCPP' as const,
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    ...inference,
    backend: 'llamaCPP',
    activeModel: 'Live-9B',
    settingsPerPreset: {},
    ensureReadyForInference: vi.fn(),
    getMissingLlmModels: vi.fn(async (_backend: string, model: string | undefined) =>
      missingModels.list.filter((missing) => missing.repo_id === model),
    ),
    bindSessionSettings: vi.fn(),
    loadSettingsForActivePreset: vi.fn(),
    settingsAvailability: {
      models: [],
      embeddingModels: [],
      services: [],
      cloudEnabled: false,
      cloudProviderIds: [],
      embeddingBackend: 'llamaCPP',
    },
    inferenceForSettings: (_presetName: string, settings: AgentSessionSettings) => ({
      inference: { ...inference, backend: settings.backend, activeModel: settings.model },
      cloud: {
        selectedProviderId: 'custom',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
      tools: { toolDelegationEnabled: true, builtinToolEnablement: {} },
    }),
  }),
  backendToAipgBackendName: { llamaCPP: 'llama_cpp', openVINO: 'openvino' },
}))

/** What the models store reports as not on disk. */
const missingModels = vi.hoisted(() => ({ list: [] as { repo_id: string }[] }))

const requestDownload = vi.hoisted(() => vi.fn(async (_models: unknown[]) => {}))

vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload: (models: unknown[]) => requestDownload(models),
  requestVramWarning: vi.fn(async () => true),
  notify: vi.fn(),
}))

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({
    checkModelAlreadyLoaded: vi.fn(async (models: { repo_id: string }[]) =>
      models.map((model) => ({
        ...model,
        already_loaded: !missingModels.list.some((missing) => missing.repo_id === model.repo_id),
      })),
    ),
  }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

vi.mock('@/assets/js/store/developerSettings', () => ({
  useDeveloperSettings: () => ({ keepModelsLoaded: false }),
}))

const demo = vi.hoisted(() => ({ enabled: false }))
vi.mock('@/assets/js/store/demoMode', () => ({ useDemoMode: () => demo }))

const errorsReport = vi.hoisted(() => vi.fn())
vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: errorsReport }) }))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
}))

vi.mock('@/assets/js/toast', () => ({ show: vi.fn() }))

vi.mock('@/assets/js/tools/agentBridge', () => ({ getAgentToolSpecs: () => [] }))

const TEMPLATE: AgentSessionSettings = {
  backend: 'llamaCPP',
  model: 'Template-27B',
  capabilities: ['files'],
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const TICK = 30_000
const NOW = Date.UTC(2026, 9, 15, 12, 0)

const every10Minutes = (overrides: Partial<AgentTaskSchedule> = {}): AgentTaskSchedule => ({
  every: 10,
  unit: 'minutes',
  startAt: NOW + 10 * MINUTE,
  enabled: true,
  ...overrides,
})

const task = (id: string, overrides: Partial<AgentTask> = {}): AgentTask => ({
  id,
  name: `Task ${id}`,
  sessionRef: SESSION,
  settingsTemplate: TEMPLATE,
  steps: [
    { id: `${id}-s0`, prompt: `${id} one` },
    { id: `${id}-s1`, prompt: `${id} two` },
  ],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

/** A Task whose Schedule next fires ten minutes from NOW. */
const scheduledTask = (id: string, overrides: Partial<AgentTask> = {}): AgentTask =>
  task(id, { schedule: every10Minutes(), nextRunAt: NOW + 10 * MINUTE, ...overrides })

const openRecord = {
  id: 'session-open',
  workspaceDir: '/work/open',
  title: 'what I am doing',
  messages: [{ id: 'open-u1', role: 'user', parts: [{ type: 'text', text: 'what I am doing' }] }],
  createdAt: 1,
  updatedAt: 2,
  presetName: 'Agent',
  settings: { backend: 'llamaCPP', model: 'Live-9B', capabilities: ['files'] },
}

let storedTasks: AgentTask[]
const kernelListeners = new Set<(event: KernelEvent) => void>()
const pushKernelEvent = (event: KernelEvent) => {
  for (const listener of [...kernelListeners]) listener(event)
}
let seq = 10

function pushEvent(payload: Record<string, unknown>): void {
  pushKernelEvent({ ...payload, scope: { kind: 'global' }, seq: ++seq } as KernelEvent)
}

const startTurn = vi.fn(async (_turnId: string, _prompt: string, _config: AgentModeTurnConfig) => ({
  success: true as boolean,
  error: undefined as string | undefined,
}))
const saveTask = vi.fn(async (_task: AgentTask) => ({ success: true as boolean, error: '' }))
const setLifecycleBusy = vi.fn((_busy: boolean) => {})

const SESSION = 'session-1'
let runHarnesses = 0

beforeEach(() => {
  vi.clearAllMocks()
  kernelListeners.clear()
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  setActivePinia(createPinia())
  seq = 10
  storedTasks = []
  missingModels.list = []
  demo.enabled = false
  activePreset.state!.preset = AGENT
  activePreset.list = [AGENT, IMAGE_GEN]
  const storage = new Map<string, string>()
  const storageShim = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }
  globalThis.localStorage = storageShim as unknown as Storage
  globalThis.sessionStorage = storageShim as unknown as Storage
  globalThis.window = {
    electronAPI: {
      onKernelEvent: vi.fn((listener: (event: KernelEvent) => void) => {
        kernelListeners.add(listener)
        return () => kernelListeners.delete(listener)
      }),
      getKernelSnapshot: vi.fn(async (): Promise<KernelSnapshot> => ({
        scope: { kind: 'global' },
        sequence: 5,
        state: {
          services: [],
          agentTurns: [],
          activeArtifactRun: null,
          chatTurns: [],
          activities: [],
          inferenceProfile: null,
        },
      })),
      existsPath: vi.fn(async () => true),
      setLifecycleBusy,
      sessions: {
        taskRunHarness: vi.fn(async () => ({
          success: true,
          harness: {
            harnessSessionId: `aipg-agent-run-${++runHarnesses}`,
            workspaceDir: '/work/task',
          },
        })),
        saveTimelineMessages: vi.fn(async () => ({ success: true })),
      },
      agentMode: {
        startTurn,
        cancel: vi.fn(async () => {}),
        saveSession: vi.fn(async () => ({ success: true })),
        onExecuteTool: vi.fn(() => () => {}),
        submitToolResult: vi.fn(),
        deleteSession: vi.fn(async () => ({ success: true })),
        bootstrapSessions: vi.fn(async () => ({
          status: 'ok',
          activeSessionId: 'session-open',
          sessions: [openRecord],
        })),
        migrateSessions: vi.fn(),
        saveActiveSessionId: vi.fn(async () => ({ success: true })),
        readWorkspaceState: vi.fn(async () => ({
          success: true,
          section: { workspaceDir: '/work/open', lastWorkspaceByKind: { pick: '/work/open' } },
        })),
        migrateWorkspaceState: vi.fn(async () => ({ success: true })),
        writeWorkspaceState: vi.fn(async () => ({ success: true })),
        readTasks: vi.fn(async () => ({ success: true, tasks: storedTasks })),
        saveTask,
        deleteTask: vi.fn(async () => ({ success: true })),
      },
      getLocaleSettings: vi.fn(async () => ({ languageOverride: null })),
      games: { read: vi.fn(async () => null), list: vi.fn(async () => []) },
    },
  } as unknown as Window & typeof globalThis
})

afterEach(async () => {
  vi.useRealTimers()
  const { unregisterAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
  unregisterAgentModeIpc()
})

const { useAgentMode } = await import('@/assets/js/store/agentMode')
const { useAgentTasks } = await import('@/assets/js/store/agentTasks')

async function readyStores(...saved: AgentTask[]) {
  storedTasks = saved
  const agentMode = useAgentMode()
  await agentMode.init()
  const tasks = useAgentTasks()
  await tasks.init()
  return { agentMode, tasks }
}

/** Let the clock run to `at`, firing the ticker on the way. */
async function runClockTo(at: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(at - Date.now())
}

const sentPrompts = () => startTurn.mock.calls.map(([, prompt]) => prompt)
/** A Step's turn carries the run's framing; its last line, minus `Step i of n: `, is the Step. */
const sentSteps = () =>
  sentPrompts().map((prompt) => (prompt.split('\n').at(-1) ?? '').replace(/^Step \d+ of \d+: /, ''))
const sentConfig = (call: number) => startTurn.mock.calls[call][2]

async function turnIdOf(call: number): Promise<string> {
  await vi.waitFor(() => expect(startTurn.mock.calls.length).toBeGreaterThan(call))
  return startTurn.mock.calls[call][0]
}

async function finishTurn(call: number): Promise<void> {
  const turnId = await turnIdOf(call)
  const sessionId = sentConfig(call).sessionId
  for (const chunk of [
    { type: 'start' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'done' },
    { type: 'text-end', id: 't' },
    { type: 'finish' },
  ]) {
    pushEvent({ type: 'agent-chunk', sessionId, turnId, chunk })
  }
  pushEvent({ type: 'agent-turn-done', sessionId, turnId })
}

/** Give the store time to start a run, if it (wrongly) would. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 10))
}

const savedCopies = (id: string) =>
  saveTask.mock.calls.map(([saved]) => saved).filter((saved) => saved.id === id)

const lastSavedTask = (id: string) => savedCopies(id).at(-1)

/** Main's one-turn-per-Session ledger, as its kernel event reports it. */
function setSessionTurns(turns: Record<string, { turnId: string; kind: 'chat' }>): void {
  pushEvent({ type: 'session-turns', turns })
}

describe('a Scheduled Run in its Session', () => {
  it('runs in the Session on a fresh Harness Session, with no Session context', async () => {
    await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE)

    await turnIdOf(0)
    expect(window.electronAPI.sessions.taskRunHarness).toHaveBeenCalledWith(SESSION)
    expect(sentConfig(0)).toMatchObject({
      sessionRef: SESSION,
      workspaceDir: '/work/task',
      taskRun: { taskName: 'Task t1', stepIndex: 1 },
    })
    expect(sentConfig(0).sessionId).toMatch(/^aipg-agent-run-/)
  })

  it('tags every Step with the Task and its index', async () => {
    await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)

    await finishTurn(0)
    await turnIdOf(1)

    expect(sentConfig(1).taskRun).toEqual({ taskName: 'Task t1', stepIndex: 2 })
    expect(sentConfig(1).sessionId).toBe(sentConfig(0).sessionId)
  })

  it('waits while the Session has a turn in flight, then runs once it is idle', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    setSessionTurns({ [SESSION]: { turnId: 'chat-1', kind: 'chat' } })

    await runClockTo(NOW + 10 * MINUTE)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(tasks.taskState('t1')).toEqual({
      running: expect.objectContaining({ stepIndex: 1, waiting: true }),
    })

    setSessionTurns({})

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['t1 one'])
  })

  it('lets the next Step wait for a turn the user started in between', async () => {
    await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)
    await turnIdOf(0)
    setSessionTurns({ [SESSION]: { turnId: 'chat-1', kind: 'chat' } })

    await finishTurn(0)
    await settleMicrotasks()
    expect(startTurn).toHaveBeenCalledTimes(1)

    setSessionTurns({})

    await turnIdOf(1)
    expect(sentSteps()).toEqual(['t1 one', 't1 two'])
  })

  it('still skips a slot that falls while its run waits for the Session', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    setSessionTurns({ [SESSION]: { turnId: 'chat-1', kind: 'chat' } })
    await runClockTo(NOW + 10 * MINUTE)

    await runClockTo(NOW + 20 * MINUTE)
    setSessionTurns({})

    await turnIdOf(0)
    await settleMicrotasks()
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 30 * MINUTE)
  })
})

describe('a Schedule reaching its Next Run', () => {
  it('starts a Scheduled Run: a new Task Session sending the first Step', async () => {
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE)

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['t1 one'])
    const sessionId = sentConfig(0).sessionId
    expect(agentMode.sessions[sessionId]).toMatchObject({
      taskId: 't1',
      workspaceDir: '/work/task',
      presetName: 'Agent',
      settings: TEMPLATE,
    })
    expect(tasks.taskState('t1')).toEqual({ running: { stepIndex: 1, stepCount: 2, sessionId } })
  })

  it('moves the Next Run to the following slot and saves it', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE)

    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 20 * MINUTE)
    expect(lastSavedTask('t1')?.nextRunAt).toBe(NOW + 20 * MINUTE)
  })

  it('does nothing before the slot', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE - TICK)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(saveTask).not.toHaveBeenCalled()
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 10 * MINUTE)
  })

  it('runs every Step of the Scheduled Run, one after another', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)

    await finishTurn(0)
    await turnIdOf(1)
    expect(sentSteps()).toEqual(['t1 one', 't1 two'])
    await finishTurn(1)

    await vi.waitFor(() =>
      expect(tasks.taskState('t1')).toEqual({
        idle: expect.objectContaining({ kind: 'completed', sessionId: sentConfig(0).sessionId }),
      }),
    )
    expect(lastSavedTask('t1')).toMatchObject({ nextRunAt: NOW + 20 * MINUTE })
  })

  it('fires outside Agent Mode without opening its session', async () => {
    activePreset.state!.preset = IMAGE_GEN
    const { agentMode } = await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE)

    await turnIdOf(0)
    expect(sentConfig(0)).toMatchObject({ presetName: 'Agent', workspaceDir: '/work/task' })
    expect(agentMode.openSessionId).toBe('session-open')
    expect(agentMode.workspaceDir).toBe('/work/open')
  })

  it('fires again at the next slot once the run is over', async () => {
    await readyStores(scheduledTask('t1', { steps: [{ id: 's0', prompt: 'only' }] }))
    await runClockTo(NOW + 10 * MINUTE)
    await finishTurn(0)
    await settleMicrotasks()

    await runClockTo(NOW + 20 * MINUTE)

    await turnIdOf(1)
    expect(sentSteps()).toEqual(['only', 'only'])
    expect(sentConfig(1).sessionId).not.toBe(sentConfig(0).sessionId)
  })

  it('still fires when a hidden window’s ticks come a minute apart', async () => {
    await readyStores(scheduledTask('t1'))

    vi.setSystemTime(NOW + 10 * MINUTE + 50_000)
    await vi.advanceTimersByTimeAsync(TICK)

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['t1 one'])
  })

  it('starts each due Task in its own session', async () => {
    await readyStores(scheduledTask('t1'), scheduledTask('t2'))

    await runClockTo(NOW + 10 * MINUTE)

    await turnIdOf(1)
    expect(sentSteps().sort()).toEqual(['t1 one', 't2 one'])
    expect(sentConfig(0).sessionId).not.toBe(sentConfig(1).sessionId)
  })
})

describe('a slot that finds a Task Run in flight', () => {
  it('is skipped while a manual run lasts, and the Next Run moves on', async () => {
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    const sessionsBefore = Object.keys(agentMode.sessions)

    await runClockTo(NOW + 10 * MINUTE)
    await settleMicrotasks()

    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(tasks.taskState('t1')).toEqual({ running: { stepIndex: 1, stepCount: 2, sessionId } })
    expect(lastSavedTask('t1')?.activeRun).not.toHaveProperty('scheduled')
    expect(lastSavedTask('t1')).not.toHaveProperty('lastOutcome')
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 20 * MINUTE)
    expect(lastSavedTask('t1')?.nextRunAt).toBe(NOW + 20 * MINUTE)
    expect(errorsReport).not.toHaveBeenCalled()
  })

  it('is skipped while the previous Scheduled Run is still going', async () => {
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)
    await turnIdOf(0)
    const sessionsBefore = Object.keys(agentMode.sessions)

    await runClockTo(NOW + 20 * MINUTE)
    await settleMicrotasks()

    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 30 * MINUTE)
  })

  it('is not made up when the run ends before the next slot', async () => {
    const { tasks } = await readyStores(scheduledTask('t1', { steps: [{ id: 's', prompt: 'x' }] }))
    await tasks.runTask('t1')
    await runClockTo(NOW + 10 * MINUTE)
    await finishTurn(0)
    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle'))

    await runClockTo(NOW + 20 * MINUTE - TICK)
    await settleMicrotasks()

    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it('is not blocked by the user’s own turn in an earlier Task Session', async () => {
    const { agentMode } = await readyStores(
      scheduledTask('t1', { steps: [{ id: 's', prompt: 'x' }] }),
    )
    await runClockTo(NOW + 10 * MINUTE)
    await finishTurn(0)
    await settleMicrotasks()
    const earlier = sentConfig(0).sessionId
    await agentMode.switchSession(earlier)
    void agentMode.generate('my own follow-up')
    await turnIdOf(1)

    await runClockTo(NOW + 20 * MINUTE)

    await turnIdOf(2)
    expect(sentSteps()).toEqual(['x', 'my own follow-up', 'x'])
    expect(sentConfig(2).sessionId).not.toBe(earlier)
  })
})

describe('a slot that was missed', () => {
  it('is skipped when the machine slept through it, and the Next Run moves on', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    // Asleep: the clock jumps past the slot without the ticker running.
    vi.setSystemTime(NOW + 15 * MINUTE)
    await vi.advanceTimersByTimeAsync(TICK)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(tasks.taskState('t1')).toEqual({ idle: undefined })
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 20 * MINUTE)
    expect(lastSavedTask('t1')?.nextRunAt).toBe(NOW + 20 * MINUTE)
  })

  it('is skipped at launch when it fell while the app was closed', async () => {
    const { tasks } = await readyStores(
      scheduledTask('t1', {
        schedule: every10Minutes({ startAt: NOW - 2 * HOUR - 3 * MINUTE }),
        nextRunAt: NOW - HOUR,
      }),
    )

    // Slots at -2h03, …, -3m, then +7m.
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 7 * MINUTE)
    expect(lastSavedTask('t1')?.nextRunAt).toBe(NOW + 7 * MINUTE)
    await vi.advanceTimersByTimeAsync(TICK)
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('leaves a future Next Run alone at launch', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 10 * MINUTE)
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('settles an interrupted run at launch without starting a new one', async () => {
    const { tasks } = await readyStores(
      scheduledTask('t1', {
        nextRunAt: NOW - 5 * MINUTE,
        schedule: every10Minutes({ startAt: NOW - 5 * MINUTE }),
        activeRun: { sessionId: 'session-old', stepIndex: 1, stepCount: 2 },
      }),
    )

    expect(lastSavedTask('t1')).toMatchObject({
      lastOutcome: { kind: 'failed', reason: 'app-closed' },
      nextRunAt: NOW + 5 * MINUTE,
    })
    expect(lastSavedTask('t1')).not.toHaveProperty('activeRun')
    expect(tasks.taskState('t1')).toHaveProperty('idle')
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
  })
})

describe('running a scheduled Task by hand', () => {
  it('leaves the Schedule and Next Run as they were', async () => {
    const { tasks } = await readyStores(scheduledTask('t1', { steps: [{ id: 's', prompt: 'x' }] }))

    await tasks.runTask('t1')
    await finishTurn(0)
    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle'))

    expect(tasks.taskSchedule('t1')).toEqual({
      schedule: every10Minutes(),
      nextRunAt: NOW + 10 * MINUTE,
    })
    expect(savedCopies('t1').length).toBeGreaterThan(0)
    for (const saved of savedCopies('t1')) {
      expect(saved).toMatchObject({ schedule: every10Minutes(), nextRunAt: NOW + 10 * MINUTE })
    }
  })

  it('skips a slot that comes due while ▶ Run waits on its model download', async () => {
    missingModels.list = [{ repo_id: TEMPLATE.model! }]
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))
    const sessionsBefore = Object.keys(agentMode.sessions).length
    let finishDownload = () => {}
    requestDownload.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )

    const running = tasks.runTask('t1')
    await vi.waitFor(() => expect(requestDownload).toHaveBeenCalledTimes(1))
    await runClockTo(NOW + 10 * MINUTE)
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()

    finishDownload()
    expect(await running).toEqual({ ok: true })
    await turnIdOf(0)
    expect(Object.keys(agentMode.sessions)).toHaveLength(sessionsBefore + 1)
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 20 * MINUTE)
  })
})

const reportedCodes = () =>
  errorsReport.mock.calls.map(([error]) => (error as { code?: string }).code)

const reported = (code: string) =>
  errorsReport.mock.calls
    .map(([error]) => error as { code?: string; surface?: string; userMessage?: string })
    .find((error) => error.code === code)

/** A template the app cannot serve: Cloud Mode is off. */
const UNUSABLE_TEMPLATE: AgentSessionSettings = { backend: 'cloud', model: 'gpt-x' }

function mintedHarness(success: boolean) {
  return success
    ? {
        success: true as const,
        harness: { harnessSessionId: 'aipg-agent-run', workspaceDir: '/work/task' },
      }
    : { success: false as const, error: 'no such session: session-1' }
}

describe('a Scheduled Run that cannot start', () => {
  it('records a failed outcome with the reason, toasts, and keeps the Schedule', async () => {
    const { agentMode, tasks } = await readyStores(
      scheduledTask('t1', { settingsTemplate: UNUSABLE_TEMPLATE }),
    )
    const sessionsBefore = Object.keys(agentMode.sessions)

    await runClockTo(NOW + 10 * MINUTE)

    await vi.waitFor(() =>
      expect(tasks.taskState('t1')).toEqual({
        idle: expect.objectContaining({ kind: 'failed', reason: 'not-started', stepCount: 2 }),
      }),
    )
    const outcome = lastSavedTask('t1')?.lastOutcome
    expect(outcome?.message).toBeTruthy()
    expect(outcome).not.toHaveProperty('sessionId')
    expect(startTurn).not.toHaveBeenCalled()
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(reported('agent-tasks/scheduled-run-not-started')).toMatchObject({ surface: 'toast' })
    expect(lastSavedTask('t1')).toMatchObject({
      schedule: every10Minutes(),
      nextRunAt: NOW + 20 * MINUTE,
    })
  })

  it('is refused when its Session is gone', async () => {
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))
    vi.mocked(window.electronAPI.sessions.taskRunHarness).mockResolvedValue({
      success: false,
      error: 'no such session: session-1',
    })
    const sessionsBefore = Object.keys(agentMode.sessions)

    await runClockTo(NOW + 10 * MINUTE)

    await vi.waitFor(() =>
      expect(tasks.taskState('t1')).toEqual({
        idle: expect.objectContaining({ kind: 'failed', reason: 'not-started' }),
      }),
    )
    expect(lastSavedTask('t1')?.lastOutcome?.message).toContain('session-1')
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(startTurn).not.toHaveBeenCalled()
    expect(reportedCodes()).toEqual(['agent-tasks/scheduled-run-not-started'])
  })

  it('is refused while the Agent preset is switched off', async () => {
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))
    activePreset.list = [IMAGE_GEN]
    const sessionsBefore = Object.keys(agentMode.sessions)

    await runClockTo(NOW + 10 * MINUTE)

    await vi.waitFor(() =>
      expect(tasks.taskState('t1')).toEqual({
        idle: expect.objectContaining({ kind: 'failed', reason: 'not-started' }),
      }),
    )
    expect(lastSavedTask('t1')?.lastOutcome?.message).toBeTruthy()
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(startTurn).not.toHaveBeenCalled()
    expect(reportedCodes()).toEqual(['agent-tasks/scheduled-run-not-started'])
  })

  it('is refused when the MCP servers it needs cannot be listed', async () => {
    const { agentMode, tasks } = await readyStores(
      scheduledTask('t1', { settingsTemplate: { ...TEMPLATE, capabilities: ['mcp:github'] } }),
    )
    const sessionsBefore = Object.keys(agentMode.sessions)

    // The fake electronAPI has no `mcp`, so listing the servers throws.
    await runClockTo(NOW + 10 * MINUTE)

    await vi.waitFor(() =>
      expect(tasks.taskState('t1')).toEqual({
        idle: expect.objectContaining({ kind: 'failed', reason: 'not-started' }),
      }),
    )
    expect(lastSavedTask('t1')?.lastOutcome?.message).toBeTruthy()
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(startTurn).not.toHaveBeenCalled()
    expect(reportedCodes()).toEqual(['agent-tasks/scheduled-run-not-started'])
  })

  it('neither starts nor writes back a Task deleted while its start is checked', async () => {
    let harnessMinted: (success: boolean) => void = () => {}
    let finishDelete: () => void = () => {}
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))
    vi.mocked(window.electronAPI.sessions.taskRunHarness).mockImplementation(
      () =>
        new Promise((resolve) => (harnessMinted = (success) => resolve(mintedHarness(success)))),
    )
    vi.mocked(window.electronAPI.agentMode.deleteTask).mockImplementation(
      () => new Promise((resolve) => (finishDelete = () => resolve({ success: true }))),
    )
    const sessionsBefore = Object.keys(agentMode.sessions)
    await runClockTo(NOW + 10 * MINUTE)
    saveTask.mockClear()

    const deleted = tasks.deleteTask('t1')
    harnessMinted(false)
    await settleMicrotasks()
    finishDelete()

    expect(await deleted).toBe(true)
    await settleMicrotasks()
    expect(saveTask).not.toHaveBeenCalled()
    expect(errorsReport).not.toHaveBeenCalled()
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
  })

  it('does not start once paused while its start is checked', async () => {
    let harnessMinted: (success: boolean) => void = () => {}
    const { tasks } = await readyStores(scheduledTask('t1'))
    vi.mocked(window.electronAPI.sessions.taskRunHarness).mockImplementation(
      () =>
        new Promise((resolve) => (harnessMinted = (success) => resolve(mintedHarness(success)))),
    )
    await runClockTo(NOW + 10 * MINUTE)

    await tasks.setSchedule('t1', every10Minutes({ enabled: false }))
    harnessMinted(true)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(tasks.taskState('t1')).toEqual({ idle: undefined })
  })

  it('tries again at its Next Run', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    vi.mocked(window.electronAPI.sessions.taskRunHarness).mockResolvedValueOnce(
      mintedHarness(false),
    )
    await runClockTo(NOW + 10 * MINUTE)
    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle.kind', 'failed'))

    await runClockTo(NOW + 20 * MINUTE)

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['t1 one'])
    expect(tasks.taskSchedule('t1')).toEqual({
      schedule: every10Minutes(),
      nextRunAt: NOW + 30 * MINUTE,
    })
  })
})

/** End the turn the `call`-th `startTurn` started with an error chunk. */
async function failTurn(call: number, errorText: string): Promise<void> {
  const turnId = await turnIdOf(call)
  const sessionId = sentConfig(call).sessionId
  pushEvent({ type: 'agent-chunk', sessionId, turnId, chunk: { type: 'start' } })
  pushEvent({ type: 'agent-chunk', sessionId, turnId, chunk: { type: 'error', errorText } })
  pushEvent({ type: 'agent-turn-done', sessionId, turnId })
}

describe('a Scheduled Run that fails part-way', () => {
  it('keeps the failed outcome, toasts it, and keeps the Schedule', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)
    await finishTurn(0)
    const sessionId = sentConfig(0).sessionId

    await failTurn(1, 'model refused')

    await vi.waitFor(() =>
      expect(tasks.taskState('t1')).toEqual({
        idle: expect.objectContaining({
          kind: 'failed',
          sessionId,
          stepIndex: 2,
          message: 'model refused',
        }),
      }),
    )
    const toast = reported('agent-tasks/scheduled-run-failed')
    expect(toast).toMatchObject({ surface: 'toast' })
    expect(toast?.userMessage).toContain('model refused')
    expect(lastSavedTask('t1')).toMatchObject({
      schedule: every10Minutes(),
      nextRunAt: NOW + 20 * MINUTE,
    })
  })

  it('toasts a Step that main refuses to start', async () => {
    startTurn.mockImplementationOnce(async () => ({ success: false, error: 'refused by main' }))
    const { tasks } = await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE)

    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle.kind', 'failed'))
    expect(reported('agent-tasks/scheduled-run-failed')).toMatchObject({ surface: 'toast' })
  })

  it('shows no error toast when the user stops it', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)
    await turnIdOf(0)

    await tasks.stopTask('t1')

    expect(tasks.taskState('t1')).toEqual({
      idle: expect.objectContaining({ kind: 'stopped', stepIndex: 1 }),
    })
    await settleMicrotasks()
    expect(errorsReport).not.toHaveBeenCalled()
  })
})

describe('a scheduled Task run by hand', () => {
  it('is refused with no outcome and no toast from the Tasks store', async () => {
    const { agentMode, tasks } = await readyStores(
      scheduledTask('t1', { settingsTemplate: UNUSABLE_TEMPLATE }),
    )
    const sessionsBefore = Object.keys(agentMode.sessions)

    expect(await tasks.runTask('t1')).toMatchObject({ ok: false, reason: 'settings-problems' })

    await settleMicrotasks()
    expect(tasks.taskState('t1')).toEqual({ idle: undefined })
    expect(saveTask).not.toHaveBeenCalled()
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(errorsReport).not.toHaveBeenCalled()
  })

  it('fails part-way without a toast', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    await tasks.runTask('t1')

    await failTurn(0, 'model refused')

    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle.kind', 'failed'))
    expect(reportedCodes()).not.toContain('agent-tasks/scheduled-run-failed')
    expect(errorsReport.mock.calls.map(([error]) => error)).not.toContainEqual(
      expect.objectContaining({ surface: 'toast' }),
    )
  })
})

describe('a Schedule that must not fire', () => {
  it('never fires while paused', async () => {
    const { tasks } = await readyStores(
      task('t1', { schedule: every10Minutes({ enabled: false }) }),
    )

    await runClockTo(NOW + HOUR)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(tasks.taskSchedule('t1')).toEqual({ schedule: every10Minutes({ enabled: false }) })
  })

  it('stops firing once paused, and fires again once resumed', async () => {
    const { tasks } = await readyStores(task('t1', { steps: [{ id: 's', prompt: 'x' }] }))
    await tasks.setSchedule('t1', every10Minutes({ enabled: false }))
    await runClockTo(NOW + 30 * MINUTE)
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()

    await tasks.setSchedule('t1', every10Minutes())
    await runClockTo(NOW + 40 * MINUTE)

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['x'])
  })

  it('never fires once removed', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    await tasks.removeSchedule('t1')
    await runClockTo(NOW + HOUR)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
  })

  it('never fires once its Task is deleted', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    expect(await tasks.deleteTask('t1')).toBe(true)
    await runClockTo(NOW + HOUR)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('does not write a Task back while its delete is in flight', async () => {
    let finishDelete: () => void = () => {}
    const { tasks } = await readyStores(scheduledTask('t1'))
    vi.mocked(window.electronAPI.agentMode.deleteTask).mockImplementation(
      () => new Promise((resolve) => (finishDelete = () => resolve({ success: true }))),
    )

    const deleted = tasks.deleteTask('t1')
    await runClockTo(NOW + 10 * MINUTE)
    finishDelete()

    expect(await deleted).toBe(true)
    await settleMicrotasks()
    expect(saveTask).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('never fires in demo mode', async () => {
    demo.enabled = true
    const { agentMode } = await readyStores(scheduledTask('t1'))
    const sessionsBefore = Object.keys(agentMode.sessions)

    await runClockTo(NOW + HOUR)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
  })
})

const DOWNLOAD_PAUSE = { kind: 'download' as const, summary: 'Template-27B' }

async function pauseTurn(call: number, pauseReason?: PauseReason): Promise<void> {
  const turnId = await turnIdOf(call)
  const sessionId = sentConfig(call).sessionId
  pushEvent({
    type: 'agent-turn-state',
    sessionId,
    turnId,
    state: 'paused',
    ...(pauseReason ? { pauseReason } : {}),
  })
}

async function resumeTurn(call: number): Promise<void> {
  const turnId = await turnIdOf(call)
  pushEvent({
    type: 'agent-turn-state',
    sessionId: sentConfig(call).sessionId,
    turnId,
    state: 'running',
  })
}

describe('a Task Run whose Task Session is paused', () => {
  it('shows what the session waits for, and stops showing it once it runs again', async () => {
    const { tasks } = await readyStores(task('t1'))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    await pauseTurn(0, DOWNLOAD_PAUSE)

    expect(tasks.taskState('t1')).toEqual({
      running: { stepIndex: 1, stepCount: 2, sessionId, paused: { reason: DOWNLOAD_PAUSE } },
    })

    await resumeTurn(0)

    expect(tasks.taskState('t1')).toEqual({ running: { stepIndex: 1, stepCount: 2, sessionId } })
  })

  it('is shown as paused when main names no reason', async () => {
    const { tasks } = await readyStores(task('t1'))
    await tasks.runTask('t1')

    await pauseTurn(0)

    expect(tasks.taskState('t1')).toMatchObject({ running: { paused: {} } })
  })

  it('counts the slots it skips while paused, keeping one Task Run at a time', async () => {
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)
    await pauseTurn(0, DOWNLOAD_PAUSE)
    const sessionsBefore = Object.keys(agentMode.sessions)

    await runClockTo(NOW + 40 * MINUTE)
    await settleMicrotasks()

    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(tasks.taskState('t1')).toMatchObject({ running: { skippedSlots: 3 } })
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 50 * MINUTE)
  })

  it('keeps the count once it runs again, but not in the saved Task', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)
    await pauseTurn(0, DOWNLOAD_PAUSE)
    await runClockTo(NOW + 20 * MINUTE)

    await resumeTurn(0)

    expect(tasks.taskState('t1')).toMatchObject({ running: { skippedSlots: 1 } })
    for (const saved of savedCopies('t1')) {
      expect(JSON.stringify(saved)).not.toContain('skipped')
    }
  })

  it('does not count slots skipped while the run is not paused', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)
    await turnIdOf(0)

    await runClockTo(NOW + 30 * MINUTE)

    expect(tasks.taskState('t1')).not.toHaveProperty('running.skippedSlots')
  })

  it('is a Scheduled Run whose chat model is missing: started, then paused, not refused', async () => {
    missingModels.list = [{ repo_id: TEMPLATE.model! }]
    const { tasks } = await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE)
    await turnIdOf(0)
    await pauseTurn(0, DOWNLOAD_PAUSE)

    expect(tasks.taskState('t1')).toMatchObject({
      running: { stepIndex: 1, paused: { reason: DOWNLOAD_PAUSE } },
    })
    expect(reportedCodes()).not.toContain('agent-tasks/scheduled-run-not-started')
    for (const saved of savedCopies('t1')) expect(saved).not.toHaveProperty('lastOutcome')
    expect(requestDownload).not.toHaveBeenCalled()
  })

  it('fails with “model download declined” when the user declines, and toasts it', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)
    await pauseTurn(0, DOWNLOAD_PAUSE)
    const sessionId = sentConfig(0).sessionId

    await failTurn(0, 'model download declined')

    await vi.waitFor(() =>
      expect(tasks.taskState('t1')).toEqual({
        idle: expect.objectContaining({
          kind: 'failed',
          sessionId,
          stepIndex: 1,
          message: 'model download declined',
          reason: 'download-declined',
        }),
      }),
    )
    expect(lastSavedTask('t1')?.lastOutcome).toMatchObject({ reason: 'download-declined' })
    expect(reported('agent-tasks/scheduled-run-failed')).toMatchObject({ surface: 'toast' })
  })

  it('starts the next run with no count', async () => {
    const { tasks } = await readyStores(scheduledTask('t1', { steps: [{ id: 's', prompt: 'x' }] }))
    await runClockTo(NOW + 10 * MINUTE)
    await pauseTurn(0, DOWNLOAD_PAUSE)
    await runClockTo(NOW + 20 * MINUTE)
    await resumeTurn(0)
    await finishTurn(0)
    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle.kind', 'completed'))

    await runClockTo(NOW + 30 * MINUTE)

    await turnIdOf(1)
    expect(tasks.taskState('t1')).not.toHaveProperty('running.skippedSlots')
  })
})

/** What main last heard over `lifecycle:busy`; its close policy hides the window while true. */
const lastBusy = () => setLifecycleBusy.mock.calls.at(-1)?.[0]

describe('keeping the app alive when the window is closed', () => {
  it('is not busy with no Schedule and no Task Run', async () => {
    await readyStores(task('t1'))
    await settleMicrotasks()

    expect(lastBusy()).toBe(false)
  })

  it('is not busy merely because a Schedule is enabled', async () => {
    const { tasks } = await readyStores(task('t1'))

    await tasks.setSchedule('t1', every10Minutes())
    await settleMicrotasks()

    expect(lastBusy()).toBe(false)
  })
  it('stays not busy when the Schedule is paused, removed, or the Task is deleted', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'), scheduledTask('t2'))
    await settleMicrotasks()
    expect(lastBusy()).toBe(false)

    await tasks.setSchedule('t1', every10Minutes({ enabled: false }))
    await tasks.removeSchedule('t2')
    await tasks.deleteTask('t1')
    await settleMicrotasks()

    expect(lastBusy()).toBe(false)
  })
  it('is busy for a whole Task Run, between its Steps too, and not after', async () => {
    const { tasks } = await readyStores(task('t1'))
    let releaseSecondStep: () => void = () => {}
    startTurn.mockImplementationOnce(startTurn.getMockImplementation()!)
    startTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSecondStep = () => resolve({ success: true, error: undefined })
        }),
    )
    await tasks.runTask('t1')
    await settleMicrotasks()
    expect(lastBusy()).toBe(true)
    setLifecycleBusy.mockClear()

    // Step one settles; Step two has been asked for but its turn has not started yet.
    await finishTurn(0)
    await turnIdOf(1)
    await settleMicrotasks()
    expect(setLifecycleBusy).not.toHaveBeenCalledWith(false)

    releaseSecondStep()
    await finishTurn(1)
    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle.kind', 'completed'))
    await settleMicrotasks()
    expect(lastBusy()).toBe(false)
  })

  it('is busy during a Scheduled Run and not after, even while the Schedule stays on', async () => {
    const { tasks } = await readyStores(scheduledTask('t1', { steps: [{ id: 's', prompt: 'x' }] }))
    await settleMicrotasks()
    expect(lastBusy()).toBe(false)

    await runClockTo(NOW + 10 * MINUTE)
    await turnIdOf(0)
    await settleMicrotasks()
    expect(lastBusy()).toBe(true)
    expect(lastSavedTask('t1')?.activeRun).toMatchObject({ scheduled: true, stepIndex: 1 })

    await finishTurn(0)
    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle.kind', 'completed'))
    await settleMicrotasks()

    expect(lastBusy()).toBe(false)
  })
  it('is not kept alive by Schedules in demo mode, where they never fire', async () => {
    demo.enabled = true
    await readyStores(scheduledTask('t1'))
    await settleMicrotasks()

    expect(lastBusy()).toBe(false)
  })
})
