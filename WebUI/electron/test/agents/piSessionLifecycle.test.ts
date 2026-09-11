import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Lifecycle tests for the Pi session manager. The behaviour that matters here is
// invisible in the UI until it breaks: one long-lived Pi session must be reused
// across turns (rebuilding it silently drops the conversation), it must be
// rebuilt when the model/workspace/tool set changes, and its session file must
// be remembered so a restart resumes instead of starting over.
//
// Pi itself, the tool builders and the workspace runtime are mocked: this is
// about the manager's bookkeeping, not about Pi's internals.

let userDataDir: string
let workspaceA: string
let workspaceB: string

const sessionFiles: string[] = []
const disposed: FakeSession[] = []

type FakeSession = {
  id: number
  sessionFile: string
  prompt: ReturnType<typeof vi.fn>
  compact: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  sendCustomMessage: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  bindExtensions: ReturnType<typeof vi.fn>
  setActiveToolsByName: ReturnType<typeof vi.fn>
  getActiveToolNames: () => string[]
  reload: ReturnType<typeof vi.fn>
  agent: { waitForIdle: ReturnType<typeof vi.fn>; state: { systemPrompt: string } }
  getSessionStats: () => {
    sessionFile: string
    tokens: Record<string, number>
    cost: number
  }
  getContextUsage: () => { tokens: number; contextWindow: number; percent: number }
  messages: unknown[]
  emit: (event: unknown) => void
}

async function makeAgentSession(): Promise<{ session: FakeSession }> {
  const id = sessionFiles.length + 1
  const sessionFile = path.join(userDataDir, 'pi', 'sessions', `session-${id}.jsonl`)
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
  fs.writeFileSync(sessionFile, '')
  sessionFiles.push(sessionFile)
  let listener: ((event: unknown) => void) | undefined
  const session: FakeSession = {
    id,
    sessionFile,
    prompt: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    abort: vi.fn(),
    dispose: vi.fn(() => {
      disposed.push(session)
    }),
    sendCustomMessage: vi.fn(async () => {}),
    bindExtensions: vi.fn(async () => {}),
    setActiveToolsByName: vi.fn(),
    getActiveToolNames: () => ['read', 'bash', 'media', 'browser'],
    reload: vi.fn(async () => {}),
    agent: { waitForIdle: vi.fn(async () => {}), state: { systemPrompt: 'system' } },
    subscribe: vi.fn((callback: (event: unknown) => void) => {
      listener = callback
      return () => {
        listener = undefined
      }
    }),
    getSessionStats: () => ({
      sessionFile,
      tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
      cost: 0,
    }),
    getContextUsage: () => ({ tokens: 1200, contextWindow: 32768, percent: 3.7 }),
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', usage: { input: 80, output: 12, cacheRead: 5 } },
    ],
    emit: (event) => listener?.(event),
  }
  return { session }
}

const createAgentSession = vi.fn(makeAgentSession)
const settingsInMemory = vi.fn((_settings?: unknown) => ({}))

const openSession = vi.fn((sessionFilePath: string) => ({ kind: 'opened', sessionFilePath }))
const createSessionManager = vi.fn((cwd: string) => ({ kind: 'created', cwd }))
const registerProvider = vi.fn()

/** What each session build asked Pi's resource loader for. */
type ResourceLoaderOptions = {
  extensionFactories?: ((pi: unknown) => void)[]
  appendSystemPrompt?: string[]
  noContextFiles?: boolean
  systemPromptOverride?: (base: string | undefined) => string | undefined
  appendSystemPromptOverride?: (base: string[]) => string[]
}
const resourceLoaderOptions: ResourceLoaderOptions[] = []

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => userDataDir },
  BrowserWindow: class {},
}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Pi itself is behind the runtime loader (it is ESM-only and loaded lazily), so
// mocking the loader is what stands in for the real agent.
vi.mock('../../agentMode/piRuntime.ts', () => ({
  loadPi: async () => ({
    ModelRuntime: {
      create: async () => ({
        registerProvider,
        setRuntimeApiKey: vi.fn(async () => {}),
        getModel: (provider: string, modelId: string) => ({ provider, id: modelId }),
      }),
    },
    SessionManager: { open: openSession, create: createSessionManager },
    SettingsManager: { inMemory: settingsInMemory },
    DefaultResourceLoader: class {
      constructor(options: ResourceLoaderOptions) {
        resourceLoaderOptions.push(options)
      }
      async reload() {}
    },
    createAgentSession,
  }),
}))

vi.mock('../../agentMode/piToolOperations', () => ({
  createAgentToolAccess: vi.fn(async ({ workspaceDir }: { workspaceDir: string }) => ({
    cwd: workspaceDir,
    skillsRoot: '/skills',
    definitions: [],
    dispose: vi.fn(async () => {}),
  })),
}))

vi.mock('../../agentMode/piCustomTools', () => ({
  writeAgentSkills: vi.fn(() => []),
  buildSkillsPromptSection: vi.fn(() => ''),
  setToolBridgeWindow: vi.fn(),
  submitAgentToolResult: vi.fn(),
  rejectAllPendingToolCalls: vi.fn(),
}))

// The capability registry reaches the MCP manager and the renderer bridge; what
// matters here is only that the manager feeds its result into the session.
vi.mock('../../agentMode/capabilities/index.ts', () => ({
  DEFAULT_CAPABILITY_IDS: ['media', 'web-debug'],
  mcpCapabilityId: (serverId: string) => `mcp:${serverId}`,
  listCapabilities: vi.fn(() => []),
  resolveCapabilities: vi.fn(async () => ({
    resolved: [],
    extensionFactories: [],
    extensionPaths: [],
    skillSources: [],
    announcedSkillNames: [],
    dormantToolNames: [],
    dormantIds: [],
    dormantPromptSection: '',
  })),
}))

vi.mock('../../agentMode/piWorkspaceRuntime', () => ({
  ensureWorkspaceRuntime: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:45678' })),
  closeWorkspaceRuntime: vi.fn(),
  buildWorkspaceInstructions: vi.fn(() => 'workspace instructions'),
}))

vi.mock('../../subprocesses/agentBrowser', () => ({
  closeBrowserSession: vi.fn(),
  closeAllBrowserSessions: vi.fn(),
}))

type SentMessage = { channel: string; payload: Record<string, unknown> }
let sent: SentMessage[]

function fakeWindow() {
  return {
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }),
    },
  }
}

function configFor(overrides: Partial<AgentModeTurnConfig> = {}): AgentModeTurnConfig {
  return {
    sessionId: 'aipg-agent-1',
    workspaceDir: workspaceA,
    modelConfig: {
      source: 'local',
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:39000/v1',
      contextWindow: 32768,
    },
    toolSpecs: [],
    capabilities: ['media', 'web-debug'],
    ...overrides,
  }
}

type Manager = typeof import('../../agentMode/piAgentManager')

async function loadManager(): Promise<Manager> {
  const manager = await import('../../agentMode/piAgentManager')
  manager.setAgentModeMainWindow(fakeWindow() as never)
  return manager
}

function pointerStore(): Record<string, { sessionFilePath: string; workspaceDir: string }> {
  const file = path.join(userDataDir, 'agent-sessions.json')
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

beforeEach(() => {
  vi.resetModules()
  createAgentSession.mockClear()
  settingsInMemory.mockClear()
  openSession.mockClear()
  createSessionManager.mockClear()
  sessionFiles.length = 0
  disposed.length = 0
  resourceLoaderOptions.length = 0
  sent = []
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-agent-session-')))
  userDataDir = path.join(root, 'userData')
  workspaceA = path.join(root, 'workspace-a')
  workspaceB = path.join(root, 'workspace-b')
  for (const dir of [userDataDir, workspaceA, workspaceB]) fs.mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(path.dirname(userDataDir), { recursive: true, force: true })
})

describe('session reuse', () => {
  it('keeps one session across turns of the same conversation', async () => {
    const manager = await loadManager()

    expect(await manager.startAgentTurn('t1', 'first', configFor())).toEqual({ success: true })
    expect(await manager.startAgentTurn('t2', 'second', configFor())).toEqual({ success: true })

    expect(createAgentSession).toHaveBeenCalledTimes(1)
    expect(disposed).toHaveLength(0)
  })

  it.each([
    ['the model changes', { modelConfig: { source: 'local', model: 'other', baseUrl: 'u' } }],
    ['the workspace changes', {}],
    ['the tool set changes', { toolSpecs: [{ name: 'media', description: 'x', inputSchema: {} }] }],
    ['capabilities change', { capabilities: ['media', 'web-debug', 'mcp:filesystem'] }],
    ['the shell mode changes', { unsandboxed: true }],
    ['the conversation changes', { sessionId: 'aipg-agent-2' }],
  ] as [string, Partial<AgentModeTurnConfig>][])('rebuilds when %s', async (label, overrides) => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'first', configFor())

    const changed = label === 'the workspace changes' ? { workspaceDir: workspaceB } : overrides
    await manager.startAgentTurn('t2', 'second', configFor(changed))

    expect(createAgentSession).toHaveBeenCalledTimes(2)
    // The replaced session must be released, or its Pi listeners keep running.
    expect(disposed).toHaveLength(1)
  })

  it('refuses a second turn while one is running', async () => {
    const manager = await loadManager()
    let release = () => {}
    // Hold the first turn open in session construction, so the second one has to
    // deal with a turn that is genuinely in flight.
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    createAgentSession.mockImplementationOnce(async () => {
      await gate
      throw new Error('cancelled')
    })

    const first = manager.startAgentTurn('t1', 'first', configFor())
    const second = await manager.startAgentTurn('t2', 'second', configFor())
    expect(second).toEqual({ success: false, error: 'An agent turn is already running.' })

    release()
    expect(await first).toEqual({ success: false, error: 'cancelled' })
    // Once it settled, the next turn is accepted again.
    expect(await manager.startAgentTurn('t3', 'third', configFor())).toEqual({ success: true })
  })
})

describe('capability wiring', () => {
  const resolution = {
    resolved: [] as unknown[],
    extensionFactories: [] as unknown[],
    extensionPaths: [] as string[],
    skillSources: [] as unknown[],
    announcedSkillNames: [] as string[],
    dormantToolNames: [] as string[],
    dormantIds: [] as string[],
    dormantPromptSection: '',
    ownSession: undefined as { baseTools: string[]; writableFiles?: string[] } | undefined,
    planningEnd: undefined as 'plan-file' | 'first-write' | undefined,
    planHandoff: undefined as string | undefined,
  }

  async function managerWith(overrides: Partial<typeof resolution> = {}) {
    const capabilities = await import('../../agentMode/capabilities/index.ts')
    vi.mocked(capabilities.resolveCapabilities).mockResolvedValue({
      ...resolution,
      ...overrides,
    } as never)
    return loadManager()
  }

  async function liveSession(): Promise<FakeSession> {
    return (await createAgentSession.mock.results[0].value).session as FakeSession
  }

  // Extensions are loaded by createAgentSession but only START in bindExtensions:
  // without it, session_start and resources_discover never fire and a capability
  // like persistent memory silently does nothing.
  it('starts the session extensions', async () => {
    const manager = await managerWith()
    await manager.startAgentTurn('t1', 'hello', configFor())

    const session = await liveSession()
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'rpc', uiContext: expect.any(Object) }),
    )
  })

  it('hides the tools of capabilities that start dormant', async () => {
    const manager = await managerWith({ dormantToolNames: ['media', 'browser'] })
    await manager.startAgentTurn('t1', 'hello', configFor())

    const session = await liveSession()
    // Narrowed, not pinned: the file/shell tools and anything an extension
    // registered for itself stay active.
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(['read', 'bash'])
  })

  it('leaves the tool set alone when everything is eager', async () => {
    const manager = await managerWith()
    await manager.startAgentTurn('t1', 'hello', configFor())

    expect((await liveSession()).setActiveToolsByName).not.toHaveBeenCalled()
  })

  // A capability that owns the session is the whole prompt and the whole
  // toolbox: Pi's coding-agent instructions and the workspace orientation are
  // replaced by the preset's text, and the builtins are cut to what it named.
  it('hands the prompt and the toolbox to a capability that owns the session', async () => {
    const manager = await managerWith({
      ownSession: { baseTools: ['write'], writableFiles: ['index.html'] },
    })
    await manager.startAgentTurn('t1', 'hello', configFor({ instructions: 'Write the game.' }))

    const { createAgentToolAccess } = await import('../../agentMode/piToolOperations')
    // Both halves of the narrowing reach the tool layer: which tools exist, and
    // which files they may write.
    expect(vi.mocked(createAgentToolAccess).mock.calls.at(-1)?.[0]).toMatchObject({
      baseTools: ['write'],
      writableFiles: ['index.html'],
    })
    const options = resourceLoaderOptions.at(-1)
    expect(options?.systemPromptOverride?.('pi coding agent prompt')).toBe('Write the game.')
    expect(options?.appendSystemPromptOverride?.(['workspace instructions'])).toEqual([])
    expect(options?.noContextFiles).toBe(true)
  })

  // The one-shot presets otherwise think and write the deliverable in a single
  // reply, which leaves the thinking switch nothing to shorten. The turn is cut
  // in two instead: the plan is asked for alone, and the harness approves it.
  describe('a session that plans before it builds', () => {
    const HANDOFF = 'The plan is approved — build it.'

    const planningManager = () => managerWith({ planHandoff: HANDOFF, planningEnd: 'first-write' })

    /** What the next request would carry, read off the live sampling extension. */
    function samplingOnTheWire(): Record<string, unknown> {
      const factory = resourceLoaderOptions.at(-1)?.extensionFactories?.at(-1)
      let onRequest: ((event: { payload: unknown }) => unknown) | undefined
      factory?.({
        on: (name: string, handler: (event: { payload: unknown }) => unknown) => {
          if (name === 'before_provider_request') onRequest = handler
        },
      })
      return (onRequest?.({ payload: {} }) ?? {}) as Record<string, unknown>
    }

    function thinkingConfig(): AgentModeTurnConfig {
      return configFor({
        modelConfig: {
          source: 'local',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:39000/v1',
          contextWindow: 32768,
          samplingParams: { chat_template_kwargs: { enable_thinking: true } },
        },
        planningThinkingOnly: true,
      })
    }

    it('asks for the build itself once the plan is in', async () => {
      const manager = await planningManager()
      await manager.startAgentTurn('t1', 'a game where I dodge rocks', thinkingConfig())

      const session = await liveSession()
      expect(session.prompt.mock.calls.map(([text]) => text)).toEqual([
        'a game where I dodge rocks',
        HANDOFF,
      ])
      expect(samplingOnTheWire().chat_template_kwargs).toEqual({ enable_thinking: false })
    })

    it('splits the turn even when the user kept thinking on throughout', async () => {
      const manager = await planningManager()
      const config = thinkingConfig()
      await manager.startAgentTurn('t1', 'hello', { ...config, planningThinkingOnly: false })

      expect((await liveSession()).prompt).toHaveBeenCalledTimes(2)
      expect(samplingOnTheWire().chat_template_kwargs).toEqual({ enable_thinking: true })
    })

    // Asking again for something the model already did would only write it twice.
    it('skips the handoff when the plan step built instead of planning', async () => {
      const manager = await planningManager()
      createAgentSession.mockImplementationOnce(async () => {
        const made = await makeAgentSession()
        made.session.prompt.mockImplementationOnce(async () => {
          made.session.emit({
            type: 'tool_execution_start',
            toolCallId: 'c1',
            toolName: 'write',
            args: { path: 'index.html' },
          })
          made.session.emit({ type: 'tool_execution_end', toolCallId: 'c1', isError: false })
        })
        return made
      })

      await manager.startAgentTurn('t1', 'hello', thinkingConfig())

      expect((await liveSession()).prompt).toHaveBeenCalledTimes(1)
    })

    it('plans once per session, not on every later request', async () => {
      const manager = await planningManager()
      await manager.startAgentTurn('t1', 'a game where I dodge rocks', thinkingConfig())
      await manager.startAgentTurn('t2', 'make the rocks faster', thinkingConfig())

      const session = await liveSession()
      expect(session.prompt.mock.calls.map(([text]) => text)).toEqual([
        'a game where I dodge rocks',
        HANDOFF,
        'make the rocks faster',
      ])
    })

    it('leaves an ordinary session as one prompt per turn', async () => {
      const manager = await managerWith()
      await manager.startAgentTurn('t1', 'hello', thinkingConfig())

      expect((await liveSession()).prompt).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps the preset instructions as an addition for an ordinary session', async () => {
    const manager = await managerWith()
    await manager.startAgentTurn('t1', 'hello', configFor({ instructions: 'Be helpful.' }))

    const options = resourceLoaderOptions.at(-1)
    expect(options?.systemPromptOverride).toBeUndefined()
    expect(options?.appendSystemPrompt).toEqual(['workspace instructions', 'Be helpful.'])
  })
})

describe('session persistence', () => {
  it('records the session file for the conversation', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())

    expect(pointerStore()['aipg-agent-1']).toMatchObject({
      workspaceDir: workspaceA,
      sessionFilePath: sessionFiles[0],
    })
    expect(createSessionManager).toHaveBeenCalledTimes(1)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('reopens the stored session file after a restart', async () => {
    const first = await loadManager()
    await first.startAgentTurn('t1', 'hello', configFor())
    const storedFile = pointerStore()['aipg-agent-1'].sessionFilePath

    // A restart: fresh module state, same userData directory on disk.
    vi.resetModules()
    openSession.mockClear()
    const second = await loadManager()
    await second.startAgentTurn('t2', 'again', configFor())

    expect(openSession).toHaveBeenCalledWith(storedFile, expect.any(String), workspaceA)
  })

  it('starts fresh when the stored session file is gone', async () => {
    const first = await loadManager()
    await first.startAgentTurn('t1', 'hello', configFor())
    fs.rmSync(pointerStore()['aipg-agent-1'].sessionFilePath)

    vi.resetModules()
    openSession.mockClear()
    createSessionManager.mockClear()
    const second = await loadManager()
    await second.startAgentTurn('t2', 'again', configFor())

    expect(openSession).not.toHaveBeenCalled()
    expect(createSessionManager).toHaveBeenCalledTimes(1)
  })

  it('starts fresh when the same conversation moved to another workspace', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())
    openSession.mockClear()

    await manager.startAgentTurn('t2', 'hello', configFor({ workspaceDir: workspaceB }))

    expect(openSession).not.toHaveBeenCalled()
    expect(pointerStore()['aipg-agent-1'].workspaceDir).toBe(workspaceB)
  })
})

describe('reset and delete', () => {
  it('reset drops the live session and its stored pointer', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())

    await manager.resetAgentSession()

    expect(disposed).toHaveLength(1)
    expect(pointerStore()).toEqual({})
    // Next turn must build a brand-new session rather than resume.
    await manager.startAgentTurn('t2', 'fresh start', configFor())
    expect(createAgentSession).toHaveBeenCalledTimes(2)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('delete removes the pointer and Pi session file', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())
    const storedFile = pointerStore()['aipg-agent-1'].sessionFilePath

    expect(await manager.deleteAgentSession('aipg-agent-1')).toEqual({ success: true })

    expect(fs.existsSync(storedFile)).toBe(false)
    expect(pointerStore()).toEqual({})
    expect(disposed).toHaveLength(1)
  })

  it('delete of an unknown session is not an error', async () => {
    const manager = await loadManager()

    expect(await manager.deleteAgentSession('aipg-agent-unknown')).toEqual({ success: true })
  })

  // A hidden browser window left behind suppresses `window-all-closed`, so the
  // app keeps running with its backends after the user closes it.
  it('app shutdown closes every browser window, not just the live runtime', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())
    const { closeAllBrowserSessions } = await import('../../subprocesses/agentBrowser')

    await manager.shutdownAgentMode()

    expect(closeAllBrowserSessions).toHaveBeenCalled()
    expect(disposed).toHaveLength(1)
  })
})

describe('turn streaming', () => {
  it('sends translated chunks and always closes the turn', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())

    const channels = sent.map((message) => message.channel)
    expect(channels).toContain('agentMode:streamChunk')
    expect(channels.at(-1)).toBe('agentMode:turnDone')
    const finish = sent
      .filter((message) => message.channel === 'agentMode:streamChunk')
      .map((message) => message.payload.chunk as Record<string, unknown>)
      .at(-1)
    expect(finish).toMatchObject({
      type: 'finish',
      messageMetadata: {
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 },
        contextUsage: { tokens: 1200, contextWindow: 32768, percent: 3.7 },
        lastStep: { inputTokens: 80, outputTokens: 12, cacheReadTokens: 5 },
      },
    })
  })

  it('revises usage metadata during the turn, not only at its end', async () => {
    const manager = await loadManager()
    createAgentSession.mockImplementationOnce(async () => {
      const created = await makeAgentSession()
      const session = created.session
      // A long agentic turn: the gauge must move while tool calls and replies
      // pile context up, instead of jumping once the turn is over.
      session.prompt.mockImplementationOnce(async () => {
        session.emit({ type: 'turn_start' })
        session.messages = [...session.messages, { role: 'toolResult', content: 'output' }]
        session.emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash' })
      })
      return created
    })

    await manager.startAgentTurn('t1', 'hello', configFor())

    const metadata = sent
      .filter((message) => message.channel === 'agentMode:streamChunk')
      .map((message) => message.payload.chunk as Record<string, unknown>)
      .filter((chunk) => chunk.type === 'message-metadata')
    expect(metadata.length).toBeGreaterThan(0)
    expect(metadata[0]).toMatchObject({
      messageMetadata: { contextUsage: { tokens: 1200, contextWindow: 32768 } },
    })
  })

  it('reports a failed turn as an error chunk before closing it', async () => {
    const manager = await loadManager()
    createAgentSession.mockImplementationOnce(async () => {
      throw new Error('model unavailable')
    })

    expect(await manager.startAgentTurn('t1', 'hello', configFor())).toEqual({
      success: false,
      error: 'model unavailable',
    })

    const chunks = sent.filter((message) => message.channel === 'agentMode:streamChunk')
    expect(chunks.at(-1)?.payload.chunk).toEqual({
      type: 'error',
      errorText: 'model unavailable',
    })
    expect(sent.at(-1)?.channel).toBe('agentMode:turnDone')
  })

  /** A session whose turns end with the given assistant messages, in order. */
  async function sessionEndingWith(...finalMessages: unknown[]): Promise<FakeSession> {
    const created = await makeAgentSession()
    const session = created.session
    session.prompt.mockImplementation(async () => {
      const next = finalMessages.shift()
      if (next) session.messages = [...session.messages, next]
    })
    createAgentSession.mockImplementationOnce(async () => created)
    return session
  }

  const silent = { role: 'assistant', content: [{ type: 'thinking', thinking: '…</tool_call>' }] }
  const answered = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }

  function noticeTexts(): string[] {
    return sent
      .filter((message) => message.channel === 'agentMode:streamChunk')
      .map((message) => message.payload.chunk as Record<string, unknown>)
      .filter((chunk) => chunk.type === 'text-delta' && String(chunk.id).startsWith('notice-'))
      .map((chunk) => String(chunk.delta))
  }

  function errorTexts(): string[] {
    return sent
      .filter((message) => message.channel === 'agentMode:streamChunk')
      .map((message) => message.payload.chunk as Record<string, unknown>)
      .filter((chunk) => chunk.type === 'error')
      .map((chunk) => String(chunk.errorText))
  }

  // Qwen has been seen emitting its tool call inside the thinking channel: the
  // provider then reports a normal `stop` with no tool call, Pi's loop has
  // nothing to run, and the task is abandoned halfway with nothing on screen.
  describe('a turn that ends with neither a reply nor a tool call', () => {
    it('asks the model to continue, and stays quiet when it does', async () => {
      const session = await sessionEndingWith(silent, answered)
      const manager = await loadManager()

      await manager.startAgentTurn('t1', 'summarize the article', configFor())

      expect(session.prompt).toHaveBeenCalledTimes(2)
      expect(session.prompt.mock.calls[1][0]).toMatch(/without a reply and without a tool call/)
      expect(noticeTexts()).toEqual([])
    })

    it('says so when the model will not pick the task back up', async () => {
      const session = await sessionEndingWith(silent, silent)
      const manager = await loadManager()

      await manager.startAgentTurn('t1', 'summarize the article', configFor())

      expect(session.prompt).toHaveBeenCalledTimes(2)
      expect(noticeTexts().join('')).toMatch(/without an answer and without running a tool/)
    })

    it('leaves a cancelled turn alone', async () => {
      const session = await sessionEndingWith(silent)
      const manager = await loadManager()
      session.prompt.mockImplementationOnce(async () => {
        manager.cancelAgentTurn()
        session.messages = [...session.messages, silent]
      })

      await manager.startAgentTurn('t1', 'summarize the article', configFor())

      expect(session.prompt).toHaveBeenCalledTimes(1)
      expect(noticeTexts()).toEqual([])
    })

    it('lets a normal turn finish in one prompt', async () => {
      const session = await sessionEndingWith(answered)
      const manager = await loadManager()

      await manager.startAgentTurn('t1', 'summarize the article', configFor())

      expect(session.prompt).toHaveBeenCalledTimes(1)
    })
  })

  // A model call the provider refuses (a retired model id, a revoked key) comes
  // back as an assistant message with stopReason 'error' and Pi resolves the
  // prompt normally, so it used to be mistaken for a silent turn: the user was
  // told the model "ended its turn without an answer" and the real 422 only
  // existed in the log.
  describe('a model call the provider refuses', () => {
    /** How Pi records a failed call: no content, stopReason 'error'. */
    function refused(errorMessage: string): unknown {
      return { role: 'assistant', content: [], stopReason: 'error', errorMessage }
    }

    const unavailable =
      'POST /v1/chat/completions -> 422 : ' +
      '{"error":{"type":"invalid_request_error","code":"model_unavailable",' +
      '"message":"Requested model name \'Qwen/Qwen3.6-35B\' is currently not available."},' +
      '"extra_fields":{"provider":"skainet","latency":1089}}'

    it('reports the provider message instead of nudging the model', async () => {
      const session = await sessionEndingWith(refused(unavailable))
      const manager = await loadManager()

      const result = await manager.startAgentTurn('t1', 'build a sokoban clone', configFor())

      expect(session.prompt).toHaveBeenCalledTimes(1)
      expect(result.success).toBe(false)
      expect(result.error).toContain("Requested model name 'Qwen/Qwen3.6-35B' is currently not")
      expect(noticeTexts()).toEqual([])
    })

    it('keeps the status line and drops the routing metadata', async () => {
      await sessionEndingWith(refused(unavailable))
      const manager = await loadManager()

      await manager.startAgentTurn('t1', 'build a sokoban clone', configFor())

      const reported = errorTexts().at(-1) ?? ''
      expect(reported).toMatch(/^POST \/v1\/chat\/completions -> 422: Requested model name/)
      expect(reported).not.toContain('extra_fields')
    })

    it('falls back to the raw text when the error carries no JSON', async () => {
      await sessionEndingWith(refused('upstream closed the connection'))
      const manager = await loadManager()

      const result = await manager.startAgentTurn('t1', 'hello', configFor())

      expect(result.error).toBe('upstream closed the connection')
    })

    it('reports a failure that follows the nudge', async () => {
      const session = await sessionEndingWith(silent, refused(unavailable))
      const manager = await loadManager()

      const result = await manager.startAgentTurn('t1', 'hello', configFor())

      expect(session.prompt).toHaveBeenCalledTimes(2)
      expect(result.success).toBe(false)
      expect(noticeTexts()).toEqual([])
    })

    it('stays quiet when the turn was cancelled', async () => {
      const session = await sessionEndingWith()
      const manager = await loadManager()
      session.prompt.mockImplementationOnce(async () => {
        manager.cancelAgentTurn()
        session.messages = [...session.messages, refused('aborted by the user')]
      })

      expect(await manager.startAgentTurn('t1', 'hello', configFor())).toEqual({ success: true })
      expect(errorTexts()).toEqual([])
    })
  })

  // A step's completion carries a tool call's arguments, so a whole file goes
  // through it. Pi rejects a tool call that was cut off, which made a 4096-token
  // ceiling enough to lose every attempt at a game of any size.
  describe('completion budget', () => {
    async function registeredMaxTokens(config: AgentModeTurnConfig): Promise<number> {
      const manager = await loadManager()
      registerProvider.mockClear()
      await manager.startAgentTurn('t1', 'hello', config)
      const [, provider] = registerProvider.mock.calls[0] as [
        string,
        { models: { maxTokens: number }[] },
      ]
      return provider.models[0].maxTokens
    }

    it('leaves a local model room for a whole file', async () => {
      // The window the agent presets ask for (128k), where the full target fits.
      const modelConfig = {
        source: 'local' as const,
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:39000/v1',
        contextWindow: 131072,
      }
      expect(await registeredMaxTokens(configFor({ modelConfig }))).toBe(32768)
    })

    it('keeps half of a small window for the conversation', async () => {
      const modelConfig = {
        source: 'local' as const,
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:39000/v1',
        contextWindow: 8192,
      }
      expect(await registeredMaxTokens(configFor({ modelConfig }))).toBe(4096)
    })

    it('allows a cloud model more, its window being far larger', async () => {
      const modelConfig = {
        source: 'cloud' as const,
        model: 'gpt-4o',
        proxyBaseUrl: 'http://127.0.0.1:45000',
        upstreamBaseUrl: 'https://api.example.com/v1',
        providerId: 'example',
        authStyle: 'bearer',
      }
      expect(await registeredMaxTokens(configFor({ modelConfig }))).toBe(16384)
    })
  })

  // Pi's 16k/20k compaction defaults overflow a 32k window. The live window has
  // to reach SettingsManager or compact cannot free enough n_ctx for the next step.
  describe('compaction settings', () => {
    it('passes window-scaled compaction into the in-memory settings', async () => {
      const manager = await loadManager()
      await manager.startAgentTurn('t1', 'hello', configFor())
      expect(settingsInMemory).toHaveBeenCalledWith({
        compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 10922 },
      })
    })

    it('keeps Pi defaults on the 128k window agent presets ask for', async () => {
      const manager = await loadManager()
      const modelConfig = {
        source: 'local' as const,
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:39000/v1',
        contextWindow: 131072,
      }
      await manager.startAgentTurn('t1', 'hello', configFor({ modelConfig }))
      expect(settingsInMemory).toHaveBeenCalledWith({
        compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      })
    })
  })

  // Sampling a model's publisher recommends (models.json `inferenceDefaults`)
  // has no typed home in Pi, so the renderer sends it as raw body fields that
  // ride on the model itself.
  describe('sampling parameters', () => {
    async function sessionModel(config: AgentModeTurnConfig): Promise<Record<string, unknown>> {
      const manager = await loadManager()
      createAgentSession.mockClear()
      await manager.startAgentTurn('t1', 'hello', config)
      const [options] = createAgentSession.mock.calls[0] as unknown as [
        { model: Record<string, unknown> },
      ]
      return options.model
    }

    it('puts the recommended sampling on the model Pi runs with', async () => {
      const samplingParams = { temperature: 1, top_p: 0.95, top_k: 20 }
      const modelConfig = {
        source: 'local' as const,
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:39000/v1',
        contextWindow: 32768,
        samplingParams,
      }
      expect(await sessionModel(configFor({ modelConfig }))).toMatchObject({
        id: 'test-model',
        samplingParams,
      })
    })

    it('leaves the model untouched when nothing is recommended', async () => {
      expect(await sessionModel(configFor())).not.toHaveProperty('samplingParams')
    })
  })

  // Pi withholds every image a tool produced — an attached sprite, a screenshot
  // of the page — from a model that is not declared as accepting images.
  describe('vision', () => {
    async function registeredInput(config: AgentModeTurnConfig): Promise<string[]> {
      const manager = await loadManager()
      registerProvider.mockClear()
      await manager.startAgentTurn('t1', 'hello', config)
      const [, provider] = registerProvider.mock.calls[0] as [
        string,
        { models: { input: string[] }[] },
      ]
      return provider.models[0].input
    }

    it('declares image input for a vision model', async () => {
      const modelConfig = {
        source: 'local' as const,
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:39000/v1',
        supportsVision: true,
      }
      expect(await registeredInput(configFor({ modelConfig }))).toEqual(['text', 'image'])
    })

    it('keeps a text-only model text-only', async () => {
      expect(await registeredInput(configFor())).toEqual(['text'])
    })
  })

  // Pi only reports thinking as thinking when the provider split it off into
  // `reasoning_content`, and only asks for that split for a model registered as
  // reasoning. It would decide both from the model's `baseUrl`, which is our
  // loopback proxy whoever the provider is (piCloudReasoning.ts).
  describe('cloud reasoning', () => {
    async function registeredModel(
      config: AgentModeTurnConfig,
    ): Promise<{ reasoning: boolean; compat?: Record<string, unknown> }> {
      const manager = await loadManager()
      registerProvider.mockClear()
      await manager.startAgentTurn('t1', 'hello', config)
      const [, provider] = registerProvider.mock.calls[0] as [
        string,
        { models: { reasoning: boolean; compat?: Record<string, unknown> }[] },
      ]
      return provider.models[0]
    }

    const cloudConfig = (overrides: Record<string, unknown>) => ({
      source: 'cloud' as const,
      model: 'zai-org/GLM-5.3-Flash',
      proxyBaseUrl: 'http://127.0.0.1:45000',
      upstreamBaseUrl: 'https://gateway.example.com/v1',
      providerId: 'example',
      authStyle: 'bearer',
      ...overrides,
    })

    it('asks a GLM for its thinking in z.ai dialect', async () => {
      const model = await registeredModel(configFor({ modelConfig: cloudConfig({}) }))
      expect(model.reasoning).toBe(true)
      expect(model.compat).toMatchObject({ thinkingFormat: 'zai', supportsDeveloperRole: false })
    })

    it('asks nothing of a model whose provider never claimed reasoning', async () => {
      const modelConfig = cloudConfig({
        model: 'gpt-4o',
        upstreamBaseUrl: 'https://api.openai.com',
      })
      const model = await registeredModel(configFor({ modelConfig }))
      expect(model.reasoning).toBe(false)
      expect(model.compat).toBeUndefined()
    })

    it('takes the provider catalog at its word', async () => {
      const modelConfig = cloudConfig({
        model: 'o4-mini',
        upstreamBaseUrl: 'https://api.openai.com',
        reasoningAdvertised: true,
      })
      const model = await registeredModel(configFor({ modelConfig }))
      expect(model.reasoning).toBe(true)
      expect(model.compat).toMatchObject({ thinkingFormat: 'openai' })
    })

    // Local backends already emit `reasoning_content` of their own accord, and
    // are driven by `chat_template_kwargs` instead of Pi's thinking parameters.
    it('leaves a local model alone', async () => {
      const model = await registeredModel(configFor())
      expect(model.reasoning).toBe(false)
    })
  })

  it('re-asserts the preview URL when the port changed', async () => {
    const runtime = await import('../../agentMode/piWorkspaceRuntime')
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())

    vi.mocked(runtime.ensureWorkspaceRuntime).mockResolvedValue({
      baseUrl: 'http://127.0.0.1:50000',
    } as never)
    await manager.startAgentTurn('t2', 'again', configFor())

    const session = (await createAgentSession.mock.results[0].value).session as FakeSession
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'workspace-preview' }),
      { deliverAs: 'nextTurn' },
    )
  })
})
