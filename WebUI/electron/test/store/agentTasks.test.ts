import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTask } from '@/types/agentTaskIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// The Agents store: saving the Open Session as an Agent and loading it back. Driven
// through its public interface against the real Agent store, with a fake
// electronAPI standing in for the kernel's files.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'pick',
  systemPrompt: 'You are the agent.',
} as ChatPreset

const catalogRef = vi.hoisted(() => ({
  state: null as { presets: ChatPreset[]; active: ChatPreset | null; saved: boolean } | null,
}))

const catalog = new Proxy({} as NonNullable<typeof catalogRef.state>, {
  get: (_target, key) => Reflect.get(catalogRef.state!, key),
  set: (_target, key, value) => Reflect.set(catalogRef.state!, key, value),
})

const addPreset = vi.fn(async (preset: ChatPreset) => {
  if (!catalog.saved) return false
  catalog.presets = [...catalog.presets.filter((entry) => entry.name !== preset.name), preset]
  return true
})
const removeUserPreset = vi.fn(async (name: string) => {
  catalog.presets = catalog.presets.filter((entry) => entry.name !== name)
  return true
})

vi.mock('@/assets/js/store/presets', async () => {
  const { reactive } = await import('vue')
  catalogRef.state = reactive({ presets: [] as ChatPreset[], active: null, saved: true })
  return {
    usePresets: () => ({
      get presets() {
        return catalog.presets
      },
      get activePresetWithVariant() {
        return catalog.active
      },
      addPreset,
      removeUserPreset,
    }),
  }
})

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset: vi.fn(async () => ({ success: true })) }),
}))

/** Models not on disk, as the models store would report them. */
let missingModels: Set<string>
const VISION_MODEL = 'Vision-8B'
const VISION_PROJECTOR = 'Vision-8B-mmproj'

const getMissingLlmModels = vi.fn(
  async (backend: string, model: string | undefined, options: { needsVision?: boolean } = {}) => {
    const wanted = [
      model,
      ...(options.needsVision && model === VISION_MODEL ? [VISION_PROJECTOR] : []),
    ]
    return wanted
      .filter((name): name is string => !!name && missingModels.has(name))
      .map((repo_id) => ({ repo_id, type: 'ggufLLM', backend }))
  },
)

const requestDownload = vi.fn(async (_models: unknown[]) => {})

vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload: (models: unknown[]) => requestDownload(models),
  requestVramWarning: vi.fn(async () => true),
  notify: vi.fn(),
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    backend: 'llamaCPP',
    activeModel: 'Live-9B',
    settingsPerPreset: {},
    embeddingBackend: 'llamaCPP',
    getMissingLlmModels,
    inferenceForSettings: (_preset: string, settings: AgentSessionSettings) => ({
      inference: {
        backend: settings.backend ?? 'llamaCPP',
        activeModel: settings.model,
        modelSupportsVision: settings.model === VISION_MODEL,
      },
    }),
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
  useModels: () => ({ checkModelAlreadyLoaded: vi.fn().mockResolvedValue([]) }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

vi.mock('@/assets/js/store/developerSettings', () => ({
  useDeveloperSettings: () => ({ keepModelsLoaded: false }),
}))

const report = vi.fn()
vi.mock('@/assets/js/store/demoMode', () => ({ useDemoMode: () => ({ enabled: false }) }))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report }) }))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
}))

vi.mock('@/assets/js/toast', () => ({ show: vi.fn() }))

vi.mock('@/assets/js/tools/agentBridge', () => ({ getAgentToolSpecs: () => [] }))

const SETTINGS: AgentSessionSettings = {
  backend: 'llamaCPP',
  model: 'Stored-27B',
  contextSize: 32768,
  planningThinkingOnly: false,
  capabilities: ['files', 'web'],
}

const ATTACHMENT_LINE = '\n\nAttached files, saved in the workspace: @attachments/sprite.png'

const userMessage = (id: string, ...texts: string[]) => ({
  id,
  role: 'user',
  parts: texts.map((text) => ({ type: 'text', text })),
})

const assistantMessage = (id: string, text: string) => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
})

type SessionFixture = { id: string; title: string; workspaceDir: string; messages: unknown[] }

let openRecord: SessionFixture
let openSessionSettings: AgentSessionSettings
let storedTasks: AgentTask[]

const saveTask = vi.fn(async (_task: AgentTask) => ({ success: true as boolean, error: '' }))
const readTasks = vi.fn(async () => ({ success: true as const, tasks: storedTasks }))

const SESSION = 'session-1'
let runHarnesses = 0

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  catalog.presets = [{ ...AGENT, image: 'data:image/png;base64,AGENT', extendedDescription: 'How' }]
  catalog.active = AGENT
  catalog.saved = true
  storedTasks = []
  missingModels = new Set()
  openSessionSettings = SETTINGS
  requestDownload.mockImplementation(async () => {})
  saveTask.mockImplementation(async () => ({ success: true, error: '' }))
  openRecord = {
    id: 'session-open',
    title: 'Tidy the docs',
    workspaceDir: '/work/open',
    messages: [
      userMessage('u1', 'rename the files'),
      assistantMessage('a1', 'renamed'),
      userMessage('u2', 'use this sprite', `${ATTACHMENT_LINE}`),
      assistantMessage('a2', 'done'),
      userMessage('u3', 'now write the readme'),
    ],
  }
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
        harnessSession: vi.fn(async () => ({
          success: true,
          harness: { harnessSessionId: 'session-open', workspaceDir: '/work/open' },
        })),
        saveTimelineMessages: vi.fn(async () => ({ success: true })),
        delete: vi.fn(async () => ({ success: true })),
        list: vi.fn(async () => ({ success: true, sessions: [] })),
        create: vi.fn(async () => ({
          success: true,
          session: {
            id: SESSION,
            title: '',
            renamed: false,
            createdAt: 1,
            updatedAt: 1,
            presetsUsed: [],
          },
        })),
      },
      agentMode: {
        startTurn: vi.fn(async () => ({ success: true })),
        cancel: vi.fn(),
        saveSession: vi.fn(async () => ({ success: true })),
        onExecuteTool: vi.fn(() => () => {}),
        submitToolResult: vi.fn(),
        deleteSession: vi.fn(async () => ({ success: true })),
        bootstrapSessions: vi.fn(async () => ({
          status: 'ok',
          activeSessionId: openRecord.id,
          sessions: [
            {
              ...openRecord,
              createdAt: 1,
              updatedAt: 2,
              presetName: 'Agent',
              settings: openSessionSettings,
            },
          ],
        })),
        migrateSessions: vi.fn(),
        saveActiveSessionId: vi.fn(async () => ({ success: true })),
        readWorkspaceState: vi.fn(async () => ({
          success: true,
          section: {
            workspaceDir: openRecord.workspaceDir,
            lastWorkspaceByKind: { pick: openRecord.workspaceDir },
          },
        })),
        migrateWorkspaceState: vi.fn(async () => ({ success: true })),
        writeWorkspaceState: vi.fn(async () => ({ success: true })),
        readTasks,
        saveTask,
        deleteTask: vi.fn(async () => ({ success: true })),
      },
      getLocaleSettings: vi.fn(async () => ({ languageOverride: null })),
      games: { read: vi.fn(async () => null), list: vi.fn(async () => []) },
    },
  } as unknown as Window & typeof globalThis
})

afterEach(async () => {
  const { unregisterAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
  unregisterAgentModeIpc()
})

const { useAgentMode } = await import('@/assets/js/store/agentMode')
const { useAgentTasks } = await import('@/assets/js/store/agentTasks')
const { useSessions } = await import('@/assets/js/store/sessions')

async function readyStores(options: { session?: boolean } = {}) {
  const agentMode = useAgentMode()
  await agentMode.init()
  if (options.session !== false) await useSessions().create()
  const tasks = useAgentTasks()
  await tasks.init()
  return { agentMode, tasks }
}

const draftOf = (name: string, ...prompts: string[]) => ({
  name,
  steps: prompts.map((prompt, index) => ({ id: `step-${index}`, prompt })),
})

describe('saving a Task', () => {
  it.each([
    ['an empty name', draftOf('  ', 'go'), 'name'],
    ['no Steps', draftOf('Docs'), 'no-steps'],
    ['an empty Step', draftOf('Docs', 'go', ' \n '), 'empty-step'],
  ])('refuses %s without persisting', async (_case, draft, reason) => {
    const { tasks } = await readyStores()

    expect(await tasks.saveTask(draft)).toEqual({ ok: false, reason })
    expect(saveTask).not.toHaveBeenCalled()
    expect(tasks.tasks).toEqual([])
  })

  it('refuses while no Session is open', async () => {
    const { tasks } = await readyStores({ session: false })

    expect(await tasks.saveTask(draftOf('Docs', 'go'))).toEqual({
      ok: false,
      reason: 'no-session',
    })
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('persists the Steps in the open Session, with its Session Settings', async () => {
    const { tasks } = await readyStores()

    const result = await tasks.saveTask(draftOf(' Docs ', 'rename', `sprite${ATTACHMENT_LINE}`))

    expect(result.ok).toBe(true)
    expect(saveTask).toHaveBeenCalledTimes(1)
    const saved = saveTask.mock.calls[0][0]
    expect(saved).toMatchObject({
      name: 'Docs',
      sessionRef: SESSION,
      settingsTemplate: SETTINGS,
      steps: [{ prompt: 'rename' }, { prompt: `sprite${ATTACHMENT_LINE}` }],
    })
    expect(saved.lastOutcome).toBeUndefined()
    expect(tasks.tasks).toEqual([saved])
  })

  it('captures what the panel holds now, not what the session was sent with', async () => {
    const { agentMode, tasks } = await readyStores()
    agentMode.setCapabilityEnabled('web', false)
    agentMode.setPlanningThinkingOnly(true)

    await tasks.saveTask(draftOf('Docs', 'go'))

    expect(saveTask.mock.calls[0][0].settingsTemplate).toMatchObject({
      model: 'Stored-27B',
      capabilities: ['files'],
      planningThinkingOnly: true,
    })
  })

  it('keeps the list unchanged and reports when the file cannot be written', async () => {
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))
    const { tasks } = await readyStores()

    const result = await tasks.saveTask(draftOf('Docs', 'go'))

    expect(result).toEqual({ ok: false, reason: 'persist-failed' })
    expect(tasks.tasks).toEqual([])
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'agent-tasks/save-failed', surface: 'toast' }),
    )
  })

  it('tells the user when the saved Tasks cannot be read', async () => {
    readTasks.mockImplementationOnce(
      async () => ({ success: false, error: 'agent tasks file unreadable' }) as never,
    )

    const { tasks } = await readyStores()

    expect(tasks.tasks).toEqual([])
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'agent-tasks/read-failed', surface: 'toast' }),
    )
  })

  it('reads saved Tasks back on the next start', async () => {
    storedTasks = [savedTask('task-1')]

    const { tasks } = await readyStores()

    expect(tasks.tasks).toEqual(storedTasks)
  })

  it('leaves a Task saved before Tasks belonged to a Session unlisted', async () => {
    const { sessionRef: _none, ...legacy } = savedTask('old')
    storedTasks = [{ ...legacy, workspaceDir: '/work/open' }, savedTask('task-1')]

    const { tasks } = await readyStores()

    expect(tasks.tasks.map((task) => task.id)).toEqual(['task-1'])
  })

  it("lists only the open Session's Tasks in its panel", async () => {
    storedTasks = [savedTask('mine'), savedTask('theirs', { sessionRef: 'session-2' })]

    const { tasks } = await readyStores()

    expect(tasks.sessionTasks.map((task) => task.id)).toEqual(['mine'])
  })
})

const savedTask = (id: string, overrides: Partial<AgentTask> = {}): AgentTask => ({
  id,
  name: `Task ${id}`,
  sessionRef: SESSION,
  settingsTemplate: SETTINGS,
  steps: [{ id: 's1', prompt: 'go' }],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const stepsOf = (...prompts: string[]) => draftOf('', ...prompts).steps

describe('the Open Session’s Steps', () => {
  it('start empty and are kept on the session’s record once edited', async () => {
    const { agentMode } = await readyStores()
    expect(agentMode.openSteps).toEqual([])

    agentMode.setOpenSteps(stepsOf('search the news', 'summarise it'))

    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual([
      'search the news',
      'summarise it',
    ])
    expect(agentMode.sessions[openRecord.id].steps?.map((step) => step.prompt)).toEqual([
      'search the news',
      'summarise it',
    ])
  })

  it('are cleared by a new session and come back with the session they belong to', async () => {
    const { agentMode } = await readyStores({ session: false })
    agentMode.setOpenSteps(stepsOf('search the news'))

    await agentMode.newSession()
    expect(agentMode.openSteps).toEqual([])

    await agentMode.switchSession(openRecord.id)
    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual(['search the news'])
  })
})

describe('saving the Open Session as an Agent', () => {
  it('says why it cannot be saved yet', async () => {
    const { agentMode, tasks } = await readyStores()

    expect(tasks.saveAgentBlocker(' ')).toBe('name')
    expect(tasks.saveAgentBlocker('News')).toBe('no-steps')
    agentMode.setOpenSteps(stepsOf('search', ' '))
    expect(tasks.saveAgentBlocker('News')).toBe('empty-step')
  })

  it('saves the Session, the panel’s settings and the Steps, and links the session', async () => {
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('search the news', 'summarise it'))
    agentMode.setCapabilityEnabled('web', false)

    const result = await tasks.saveAgent(' News ')

    expect(result.ok).toBe(true)
    const saved = saveTask.mock.calls[0][0]
    expect(saved).toMatchObject({
      name: 'News',
      sessionRef: SESSION,
      settingsTemplate: { model: 'Stored-27B', capabilities: ['files'] },
      steps: [{ prompt: 'search the news' }, { prompt: 'summarise it' }],
    })
    expect(agentMode.openTaskId).toBe(saved.id)
    expect(agentMode.sessions[openRecord.id].taskId).toBe(saved.id)
    expect(tasks.openSessionTask?.id).toBe(saved.id)
  })

  it('leaves the session unlinked when the file cannot be written', async () => {
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('search the news'))

    expect(await tasks.saveAgent('News')).toEqual({ ok: false, reason: 'persist-failed' })
    expect(agentMode.openTaskId).toBeUndefined()
  })

  it('keeps the Steps it saved even when they are edited afterwards', async () => {
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('search the news'))
    await tasks.saveAgent('News')

    agentMode.setOpenSteps(stepsOf('search the news', 'find a source'))

    expect(tasks.tasks[0].steps.map((step) => step.prompt)).toEqual(['search the news'])
  })
})

describe('updating an Agent', () => {
  const outcome = { kind: 'completed' as const, at: 5, sessionId: 'session-run', stepCount: 1 }

  it('overwrites it in place, keeping its identity, position, schedule and last outcome', async () => {
    const schedule = { every: 1, unit: 'days' as const, startAt: 100, enabled: true }
    storedTasks = [
      savedTask('task-1'),
      savedTask('task-2', { createdAt: 10, updatedAt: 11, lastOutcome: outcome, schedule }),
      savedTask('task-3'),
    ]
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('search', 'find a source', 'summarise'))

    const result = await tasks.updateAgent('task-2', ' Nightly news ')

    expect(result.ok).toBe(true)
    const saved = saveTask.mock.calls.at(-1)![0]
    expect(saved).toMatchObject({
      id: 'task-2',
      name: 'Nightly news',
      sessionRef: SESSION,
      settingsTemplate: SETTINGS,
      createdAt: 10,
      lastOutcome: outcome,
      schedule,
    })
    expect(saved.steps.map((step) => step.prompt)).toEqual(['search', 'find a source', 'summarise'])
    expect(saved.updatedAt).toBeGreaterThan(11)
    expect(tasks.tasks.map((task) => task.id)).toEqual(['task-1', 'task-2', 'task-3'])
    expect(agentMode.openTaskId).toBe('task-2')
  })

  it.each([
    ['an empty name', ' ', ['go'], 'name'],
    ['no Steps', 'News', [], 'no-steps'],
    ['an empty Step', 'News', ['  '], 'empty-step'],
  ])('is refused with %s', async (_case, name, prompts, reason) => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf(...prompts))

    expect(await tasks.updateAgent('task-1', name)).toEqual({ ok: false, reason })
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('refuses an Agent that does not exist', async () => {
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('go'))

    expect(await tasks.updateAgent('missing', 'News')).toEqual({ ok: false, reason: 'no-task' })
  })

  it('puts the saved Agent back when the file cannot be written', async () => {
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('changed'))

    expect(await tasks.updateAgent('task-1', 'Renamed')).toEqual({
      ok: false,
      reason: 'persist-failed',
    })
    expect(tasks.tasks[0]).toEqual(savedTask('task-1'))
    expect(agentMode.openTaskId).toBeUndefined()
  })
})

describe('loading an Agent', () => {
  const NPU_SETTINGS: AgentSessionSettings = {
    ...SETTINGS,
    backend: 'openVINO',
    model: 'Saved-NPU',
    capabilities: ['files'],
  }

  it('opens a new Draft Session set up as the Agent is', async () => {
    storedTasks = [
      savedTask('task-1', {
        settingsTemplate: NPU_SETTINGS,
        steps: [
          { id: 's1', prompt: 'search the news' },
          { id: 's2', prompt: 'summarise it' },
        ],
      }),
    ]
    const { agentMode, tasks } = await readyStores({ session: false })

    expect(await tasks.loadAgent('task-1')).toBe(true)

    expect(agentMode.openSessionId).not.toBe(openRecord.id)
    expect(agentMode.sessions[agentMode.openSessionId]).toBeUndefined()
    expect(agentMode.workspaceDir).toBe('/work/open')
    expect(agentMode.openSessionSettings).toMatchObject({ model: 'Saved-NPU', backend: 'openVINO' })
    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual([
      'search the news',
      'summarise it',
    ])
    expect(agentMode.openTaskId).toBe('task-1')
    expect(tasks.openSessionTask?.id).toBe('task-1')
  })

  it('works on a copy, so editing the loaded Steps leaves the Agent alone', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    await tasks.loadAgent('task-1')

    agentMode.setOpenSteps(stepsOf('go', 'and more'))

    expect(tasks.tasks[0]).toEqual(savedTask('task-1'))
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('leaves the session it came from untouched', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('my own step'))

    await tasks.loadAgent('task-1')
    await agentMode.switchSession(openRecord.id)

    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual(['my own step'])
    expect(agentMode.openTaskId).toBeUndefined()
  })

  it('refuses an Agent that does not exist', async () => {
    const { agentMode, tasks } = await readyStores()

    expect(await tasks.loadAgent('missing')).toBe(false)
    expect(agentMode.openSessionId).toBe(openRecord.id)
  })
})

describe('deleting a Session', () => {
  it('forgets its Tasks and their presets, and keeps the Tasks of other Sessions', async () => {
    storedTasks = [savedTask('mine'), savedTask('theirs', { sessionRef: 'session-2' })]
    const { tasks } = await readyStores()
    await tasks.saveAgentAsPreset('mine', { description: 'x' })

    await useSessions().remove(SESSION)

    await vi.waitFor(() => expect(tasks.tasks.map((task) => task.id)).toEqual(['theirs']))
    expect(removeUserPreset).toHaveBeenCalledWith('Task mine')
    expect(window.electronAPI.agentMode.deleteTask).not.toHaveBeenCalled()
  })
})

describe('deleting a Task', () => {
  it('removes it from the file and the list, and keeps the sessions', async () => {
    storedTasks = [savedTask('task-1'), savedTask('task-2')]
    const runSession = {
      id: 'session-run',
      title: 'Task task-1',
      workspaceDir: '/work/open',
      messages: [userMessage('r1', 'go'), assistantMessage('r2', 'went')],
      createdAt: 3,
      updatedAt: 4,
      presetName: 'Agent',
      settings: SETTINGS,
    }
    const bootstrap = vi.mocked(window.electronAPI.agentMode.bootstrapSessions)
    const opened = (await bootstrap()) as { status: 'ok'; sessions: unknown[] }
    bootstrap.mockResolvedValueOnce({
      ...opened,
      sessions: [...opened.sessions, runSession],
    } as never)
    const { agentMode, tasks } = await readyStores()

    expect(await tasks.deleteTask('task-1')).toBe(true)

    expect(window.electronAPI.agentMode.deleteTask).toHaveBeenCalledWith('task-1')
    expect(tasks.tasks.map((task) => task.id)).toEqual(['task-2'])
    expect(window.electronAPI.agentMode.deleteSession).not.toHaveBeenCalled()
    expect(Object.keys(agentMode.sessions)).toEqual(
      expect.arrayContaining([openRecord.id, runSession.id]),
    )
  })

  it('unlinks the Open Session when it was loaded from the deleted Agent', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    await tasks.loadAgent('task-1')

    await tasks.deleteTask('task-1')

    expect(agentMode.openTaskId).toBeUndefined()
    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual(['go'])
  })

  it('keeps the Task and reports when the file cannot be written', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()
    vi.mocked(window.electronAPI.agentMode.deleteTask).mockResolvedValueOnce({
      success: false,
      error: 'disk full',
    })

    expect(await tasks.deleteTask('task-1')).toBe(false)

    expect(tasks.tasks.map((task) => task.id)).toEqual(['task-1'])
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'agent-tasks/delete-failed', surface: 'toast' }),
    )
  })
})

describe('a Task’s state', () => {
  it('is idle with no outcome for a Task that never ran', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()

    expect(tasks.taskState('task-1')).toEqual({ idle: undefined })
  })

  it('is idle with the last outcome for a Task that ran', async () => {
    const lastOutcome = {
      kind: 'failed' as const,
      at: 5,
      sessionId: 'session-run',
      stepIndex: 2,
      stepCount: 3,
      message: 'model not available',
    }
    storedTasks = [savedTask('task-1', { lastOutcome })]
    const { tasks } = await readyStores()

    expect(tasks.taskState('task-1')).toEqual({ idle: lastOutcome })
  })
})

describe('saving an Agent whose chat model is not downloaded', () => {
  it('saves without asking for a download', async () => {
    missingModels = new Set(['Stored-27B'])
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('go'))

    expect((await tasks.saveAgent('News')).ok).toBe(true)
    expect(getMissingLlmModels).not.toHaveBeenCalled()
    expect(requestDownload).not.toHaveBeenCalled()
    expect(saveTask).toHaveBeenCalledTimes(1)
  })

  it('updates without asking for a download', async () => {
    storedTasks = [savedTask('task-1')]
    missingModels = new Set(['Stored-27B'])
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('go'))

    expect((await tasks.updateAgent('task-1', 'Renamed')).ok).toBe(true)
    expect(requestDownload).not.toHaveBeenCalled()
    expect(saveTask.mock.calls.at(-1)![0].name).toBe('Renamed')
  })
})

describe('renaming an Agent', () => {
  it('changes only its name, whatever the Open Session holds', async () => {
    storedTasks = [savedTask('task-1'), savedTask('task-2')]
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('something else entirely'))

    const result = await tasks.renameAgent('task-2', ' Nightly ')

    expect(result.ok).toBe(true)
    expect(saveTask.mock.calls.at(-1)![0]).toMatchObject({
      ...savedTask('task-2'),
      name: 'Nightly',
      updatedAt: expect.any(Number),
    })
    expect(tasks.tasks[1].steps).toEqual(savedTask('task-2').steps)
    expect(agentMode.openTaskId).toBeUndefined()
  })

  it('refuses an empty name and writes nothing for the same name', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()

    expect(await tasks.renameAgent('task-1', '  ')).toEqual({ ok: false, reason: 'name' })
    expect((await tasks.renameAgent('task-1', 'Task task-1')).ok).toBe(true)
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('puts the old name back when the file cannot be written', async () => {
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()

    expect(await tasks.renameAgent('task-1', 'New')).toEqual({
      ok: false,
      reason: 'persist-failed',
    })
    expect(tasks.tasks[0].name).toBe('Task task-1')
  })
})

describe('unsaved changes to a loaded Agent', () => {
  it('are none right after loading, and show once a Step or setting changes', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    expect(tasks.openSessionAgentChanged).toBe(false)

    await tasks.loadAgent('task-1')
    expect(tasks.openSessionAgentChanged).toBe(false)

    agentMode.setOpenSteps(stepsOf('go', 'and more'))
    expect(tasks.openSessionAgentChanged).toBe(true)

    agentMode.setOpenSteps(stepsOf('go'))
    expect(tasks.openSessionAgentChanged).toBe(false)

    agentMode.setCapabilityEnabled('web', false)
    expect(tasks.openSessionAgentChanged).toBe(true)
  })

  it('are gone once the Agent is updated', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    await tasks.loadAgent('task-1')
    agentMode.setOpenSteps(stepsOf('go', 'and more'))

    await tasks.updateAgent('task-1', 'Task task-1')

    expect(tasks.openSessionAgentChanged).toBe(false)
  })
})

describe('saving an Agent as a Chat preset', () => {
  const ICON = 'data:image/png;base64,ICON'

  it('adds an agent preset named after the Agent, bound to it, with its description and icon', async () => {
    storedTasks = [savedTask('task-1', { name: 'Morning news' })]
    const { tasks } = await readyStores()

    const result = await tasks.saveAgentAsPreset('task-1', {
      description: '  Reads the news  ',
      image: ICON,
    })

    expect(result.ok).toBe(true)
    const preset = tasks.presetOfAgent('task-1')
    expect(preset).toMatchObject({
      type: 'chat',
      name: 'Morning news',
      agentPreset: true,
      agentWorkspace: 'pick',
      systemPrompt: 'You are the agent.',
      description: 'Reads the news',
      image: ICON,
      agentTaskId: 'task-1',
    })
    expect(preset?.extendedDescription).toBeUndefined()
  })

  it('uses the Agent preset’s icon when none is chosen', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()

    await tasks.saveAgentAsPreset('task-1', { description: 'x' })

    expect(tasks.presetOfAgent('task-1')?.image).toBe('data:image/png;base64,AGENT')
  })

  it('refuses a name another preset already has', async () => {
    storedTasks = [savedTask('task-1', { name: 'Agent' })]
    const { tasks } = await readyStores()

    expect(await tasks.saveAgentAsPreset('task-1', { description: 'x' })).toEqual({
      ok: false,
      reason: 'name-taken',
    })
    expect(addPreset).not.toHaveBeenCalled()
  })

  it('keeps the preset’s name when it is updated after the Agent was renamed', async () => {
    storedTasks = [savedTask('task-1', { name: 'Morning news' })]
    const { tasks } = await readyStores()
    await tasks.saveAgentAsPreset('task-1', { description: 'first' })
    await tasks.renameAgent('task-1', 'Evening news')

    const result = await tasks.saveAgentAsPreset('task-1', { description: 'second' })

    expect(result.ok).toBe(true)
    expect(catalog.presets.filter((preset) => preset.agentTaskId === 'task-1')).toEqual([
      expect.objectContaining({ name: 'Morning news', description: 'second' }),
    ])
  })

  it('reports when the preset file cannot be written', async () => {
    storedTasks = [savedTask('task-1')]
    catalog.saved = false
    const { tasks } = await readyStores()

    expect(await tasks.saveAgentAsPreset('task-1', { description: 'x' })).toEqual({
      ok: false,
      reason: 'persist-failed',
    })
    expect(tasks.presetOfAgent('task-1')).toBeUndefined()
  })

  it('is removed with the Agent', async () => {
    storedTasks = [savedTask('task-1', { name: 'Morning news' })]
    const { tasks } = await readyStores()
    await tasks.saveAgentAsPreset('task-1', { description: 'x' })

    await tasks.deleteTask('task-1')

    expect(removeUserPreset).toHaveBeenCalledWith('Morning news')
    expect(tasks.presetOfAgent('task-1')).toBeUndefined()
  })

  it('starts each new session of the preset set up as its Agent', async () => {
    storedTasks = [
      savedTask('task-1', { name: 'Morning news', steps: [{ id: 's1', prompt: 'read' }] }),
    ]
    const { agentMode, tasks } = await readyStores({ session: false })
    const saved = await tasks.saveAgentAsPreset('task-1', { description: 'x' })
    if (!saved.ok) throw new Error('not saved')
    catalog.active = saved.preset
    await new Promise((resolve) => setTimeout(resolve, 0))

    await agentMode.newSession()

    expect(agentMode.openTaskId).toBe('task-1')
    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual(['read'])
    expect(tasks.presetAgent?.id).toBe('task-1')
  })
})
