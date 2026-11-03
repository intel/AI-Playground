import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTask, AgentTaskSchedule } from '@/types/agentTaskIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// Giving a Task a Schedule: the Tasks store validates it, works out its Next Run
// and saves both on the Task. Driven through the Tasks store against the real
// Agent store, with a fake electronAPI and a pinned clock.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'pick',
  systemPrompt: 'You are the agent.',
} as ChatPreset

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({ presets: [AGENT], activePresetWithVariant: AGENT }),
}))

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset: vi.fn(async () => ({ success: true })) }),
}))

const missingModel = { repo_id: 'Template-27B', type: 'ggufLLM', backend: 'llama_cpp' }
const getMissingLlmModels = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []))
const checkModelAlreadyLoaded = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []))
const requestDownload = vi.hoisted(() => vi.fn(async (_models: unknown[]) => {}))

vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload: (models: unknown[]) => requestDownload(models),
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    backend: 'llamaCPP',
    activeModel: 'Live-9B',
    settingsPerPreset: {},
    embeddingBackend: 'llamaCPP',
    getMissingLlmModels,
    inferenceForSettings: () => ({ inference: { backend: 'llamaCPP', activeModel: 'Stored-27B' } }),
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
  }),
  backendToAipgBackendName: { llamaCPP: 'llama_cpp', openVINO: 'openvino' },
}))

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({ checkModelAlreadyLoaded }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

vi.mock('@/assets/js/store/developerSettings', () => ({
  useDeveloperSettings: () => ({ keepModelsLoaded: false }),
}))

vi.mock('@/assets/js/store/demoMode', () => ({ useDemoMode: () => ({ enabled: false }) }))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: vi.fn() }) }))

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

const task = (id: string, overrides: Partial<AgentTask> = {}): AgentTask => ({
  id,
  name: `Task ${id}`,
  sessionRef: SESSION,
  settingsTemplate: TEMPLATE,
  steps: [{ id: `${id}-s0`, prompt: 'one' }],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

let storedTasks: AgentTask[]

const saveTask = vi.fn(async (_task: AgentTask) => ({ success: true as boolean, error: '' }))

const originalTz = process.env.TZ

const SESSION = 'session-1'
let runHarnesses = 0

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  setActivePinia(createPinia())
  storedTasks = []
  saveTask.mockImplementation(async () => ({ success: true, error: '' }))
  getMissingLlmModels.mockResolvedValue([])
  checkModelAlreadyLoaded.mockResolvedValue([])
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
      onKernelEvent: vi.fn((_listener: (event: KernelEvent) => void) => () => {}),
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
        startTurn: vi.fn(async () => ({ success: true })),
        cancel: vi.fn(),
        saveSession: vi.fn(async () => ({ success: true })),
        onExecuteTool: vi.fn(() => () => {}),
        submitToolResult: vi.fn(),
        deleteSession: vi.fn(async () => ({ success: true })),
        bootstrapSessions: vi.fn(async () => ({ status: 'ok', activeSessionId: '', sessions: [] })),
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
  process.env.TZ = originalTz
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

const lastSavedTask = (id: string) =>
  saveTask.mock.calls.map(([saved]) => saved).findLast((saved) => saved.id === id)

const NOW = Date.UTC(2026, 9, 15, 12, 0)

const schedule = (overrides: Partial<AgentTaskSchedule> = {}): AgentTaskSchedule => ({
  every: 2,
  unit: 'hours',
  startAt: NOW + 30 * MINUTE,
  enabled: true,
  ...overrides,
})

describe('giving a Task a Schedule', () => {
  it('saves the Schedule with its first slot as the Next Run', async () => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(task('t1'))

    expect(await tasks.setSchedule('t1', schedule())).toMatchObject({ ok: true })

    expect(lastSavedTask('t1')).toMatchObject({
      schedule: schedule(),
      nextRunAt: NOW + 30 * MINUTE,
    })
    expect(tasks.taskSchedule('t1')).toEqual({
      schedule: schedule(),
      nextRunAt: NOW + 30 * MINUTE,
    })
  })

  it('takes a start in the past to mean the next slot after now', async () => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(task('t1'))

    await tasks.setSchedule('t1', schedule({ startAt: NOW - 5 * HOUR - 15 * MINUTE }))

    // Slots at -5h15, -3h15, -1h15, then +45 minutes.
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 45 * MINUTE)
    expect(lastSavedTask('t1')?.nextRunAt).toBe(NOW + 45 * MINUTE)
  })

  it('does not run at a slot that is exactly now', async () => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(task('t1'))

    await tasks.setSchedule('t1', schedule({ every: 10, unit: 'minutes', startAt: NOW }))

    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 10 * MINUTE)
  })

  it('replaces an earlier Schedule', async () => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(task('t1', { schedule: schedule(), nextRunAt: NOW + HOUR }))

    await tasks.setSchedule('t1', schedule({ every: 1, unit: 'days', startAt: NOW + 3 * HOUR }))

    expect(tasks.taskSchedule('t1')).toEqual({
      schedule: schedule({ every: 1, unit: 'days', startAt: NOW + 3 * HOUR }),
      nextRunAt: NOW + 3 * HOUR,
    })
  })

  it.each([
    ['fewer than five minutes', { every: 4, unit: 'minutes' }, 'too-short'],
    ['a count below one', { every: 0, unit: 'hours' }, 'invalid-count'],
    ['a count that is not whole', { every: 1.5, unit: 'days' }, 'invalid-count'],
    ['no start time', { startAt: Number.NaN }, 'missing-start'],
  ] as const)('rejects %s and saves nothing', async (_case, overrides, problem) => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(task('t1'))

    expect(await tasks.setSchedule('t1', schedule(overrides))).toEqual({
      ok: false,
      reason: 'invalid',
      problem,
    })

    expect(saveTask).not.toHaveBeenCalled()
    expect(tasks.taskSchedule('t1')).toEqual({})
  })

  it('is not held back by a missing model and starts no download', async () => {
    vi.setSystemTime(NOW)
    getMissingLlmModels.mockResolvedValue([{ ...missingModel, already_loaded: false }])
    checkModelAlreadyLoaded.mockResolvedValue([{ ...missingModel, already_loaded: false }])
    const { tasks } = await readyStores(task('t1'))

    expect(await tasks.setSchedule('t1', schedule())).toMatchObject({ ok: true })

    expect(lastSavedTask('t1')).toMatchObject({ schedule: schedule() })
    expect(requestDownload).not.toHaveBeenCalled()
  })

  it('accepts exactly five minutes', async () => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(task('t1'))

    expect(await tasks.setSchedule('t1', schedule({ every: 5, unit: 'minutes' }))).toMatchObject({
      ok: true,
    })
  })

  it('refuses a Task that does not exist', async () => {
    const { tasks } = await readyStores(task('t1'))

    expect(await tasks.setSchedule('nope', schedule())).toEqual({ ok: false, reason: 'no-task' })
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('keeps the previous Schedule when the save fails', async () => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(task('t1', { schedule: schedule(), nextRunAt: NOW + HOUR }))
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))

    expect(await tasks.setSchedule('t1', schedule({ every: 3 }))).toEqual({
      ok: false,
      reason: 'persist-failed',
    })

    expect(tasks.taskSchedule('t1')).toEqual({ schedule: schedule(), nextRunAt: NOW + HOUR })
  })
})

describe('pausing a Schedule', () => {
  it('keeps a disabled Schedule but no Next Run', async () => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(task('t1', { schedule: schedule(), nextRunAt: NOW + HOUR }))

    await tasks.setSchedule('t1', schedule({ enabled: false }))

    expect(tasks.taskSchedule('t1')).toEqual({ schedule: schedule({ enabled: false }) })
    expect(lastSavedTask('t1')).toMatchObject({ schedule: { enabled: false } })
    expect(lastSavedTask('t1')).not.toHaveProperty('nextRunAt')
  })

  it('works out the Next Run again when re-enabled', async () => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(task('t1'))
    await tasks.setSchedule('t1', schedule({ enabled: false }))

    vi.setSystemTime(NOW + 3 * HOUR)
    await tasks.setSchedule('t1', schedule())

    // Slots at +30m, +2h30, +4h30.
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 4 * HOUR + 30 * MINUTE)
  })
})

describe('removing a Schedule', () => {
  it('saves the Task without Schedule or Next Run', async () => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(task('t1', { schedule: schedule(), nextRunAt: NOW + HOUR }))

    expect(await tasks.removeSchedule('t1')).toBe(true)

    expect(tasks.taskSchedule('t1')).toEqual({})
    const saved = lastSavedTask('t1')!
    expect(saved).not.toHaveProperty('schedule')
    expect(saved).not.toHaveProperty('nextRunAt')
    expect(saved).toMatchObject({ name: 'Task t1', steps: [{ prompt: 'one' }] })
  })
})

describe('a Schedule and the rest of the Task', () => {
  it('reads a saved Schedule after a restart', async () => {
    vi.setSystemTime(NOW)
    const { tasks } = await readyStores(
      task('t1', { schedule: schedule(), nextRunAt: NOW + 30 * MINUTE }),
      task('t2'),
    )

    expect(tasks.taskSchedule('t1')).toEqual({
      schedule: schedule(),
      nextRunAt: NOW + 30 * MINUTE,
    })
    expect(tasks.taskSchedule('t2')).toEqual({})
  })

  it('keeps the Schedule and Next Run when the Agent is updated', async () => {
    vi.setSystemTime(NOW)
    const { agentMode, tasks } = await readyStores(
      task('t1', { schedule: schedule(), nextRunAt: NOW + HOUR }),
    )

    await tasks.loadAgent('t1')
    agentMode.setOpenSteps([{ id: 'n1', prompt: 'reworded' }])
    expect((await tasks.updateAgent('t1', 'Task t1')).ok).toBe(true)

    expect(lastSavedTask('t1')).toMatchObject({
      steps: [{ prompt: 'reworded' }],
      schedule: schedule(),
      nextRunAt: NOW + HOUR,
    })
    expect(tasks.taskSchedule('t1')).toEqual({ schedule: schedule(), nextRunAt: NOW + HOUR })
  })
})

describe('slots across a daylight-saving change', () => {
  // Berlin moves from CET (UTC+1) to CEST (UTC+2) at 02:00 on Sunday 29 March 2026.
  const berlin = (day: number, hour: number) => Date.UTC(2026, 2, day, hour - (day >= 29 ? 2 : 1))

  it.each([
    ['days', 1, berlin(30, 8)],
    ['weeks', 1, berlin(4 + 31, 8)],
  ] as const)('keeps the wall-clock time for %s', async (unit, every, expected) => {
    process.env.TZ = 'Europe/Berlin'
    const start = berlin(28, 8)
    vi.setSystemTime(unit === 'days' ? berlin(30, 7) : berlin(30, 12))
    const { tasks } = await readyStores(task('t1'))

    await tasks.setSchedule('t1', schedule({ every, unit, startAt: start }))

    expect(tasks.taskSchedule('t1').nextRunAt).toBe(expected)
    expect(new Date(expected).getHours()).toBe(8)
  })

  it('keeps fixed durations for hours', async () => {
    process.env.TZ = 'Europe/Berlin'
    const start = berlin(28, 8)
    vi.setSystemTime(berlin(30, 7))
    const { tasks } = await readyStores(task('t1'))

    await tasks.setSchedule('t1', schedule({ every: 24, unit: 'hours', startAt: start }))

    // 48 hours after 08:00 CET is 09:00 CEST.
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(start + 48 * HOUR)
    expect(new Date(start + 48 * HOUR).getHours()).toBe(9)
  })
})
