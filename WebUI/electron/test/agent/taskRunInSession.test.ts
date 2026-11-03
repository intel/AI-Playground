import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'

// A Task Run inside its Session, seen from outside main: a real Pi session runs
// each Step against a fake OpenAI-compatible backend served through `fetch`, so
// the assertions are on the request bodies Pi sent and on the Session's files.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-task-run-')))

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

vi.mock('../../persist/userDataPaths.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persist/userDataPaths.ts')>()),
  getSessionsDir: () => path.join(tempRoot, 'sessions'),
  getSessionsDemoDir: () => path.join(tempRoot, 'sessions-demo'),
}))

const BACKEND = 'http://fake-llm.test/v1'

type Body = { messages?: Array<{ role: string; content?: unknown }> }

/** Request bodies the fake backend received, in order. */
let bodies: Body[] = []
/** A tool call the backend makes once, before it answers. */
let toolCall: { name: string; args: Record<string, unknown> } | null = null

function frame(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
}

function completion(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function reply(body: Body): Response {
  const call = toolCall && !body.messages?.some((message) => message.role === 'tool')
  const chunks = call
    ? [
        completion({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: toolCall!.name, arguments: JSON.stringify(toolCall!.args) },
            },
          ],
        }),
        completion({}, 'tool_calls'),
      ]
    : [completion({ role: 'assistant', content: `reply ${bodies.length}` }), completion({}, 'stop')]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(frame(chunk))
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    if (!request.url.startsWith(BACKEND)) return realFetch(input, init)
    const text = await request.text()
    const body = text ? (JSON.parse(text) as Body) : {}
    bodies.push(body)
    return reply(body)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let manager: typeof import('../../agent/piAgentManager')
let sessions: typeof import('../../session/sessions')
let harness: typeof import('../../session/sessionHarness')
let history: typeof import('../../session/sessionHistory')
let store: typeof import('../../agent/piSessionStore')
let taskRuns: typeof import('../../session/sessionTaskRuns')

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  sessions = await import('../../session/sessions')
  harness = await import('../../session/sessionHarness')
  history = await import('../../session/sessionHistory')
  store = await import('../../agent/piSessionStore')
  taskRuns = await import('../../session/sessionTaskRuns')
  sessions.setSessionDeps({ isDemoMode: () => false })
  const fakeWindow = { isDestroyed: () => false, webContents: { send: () => {} } }
  const bus = await import('../../kernel/kernelBus')
  bus.setKernelEventWindow(fakeWindow as never)
  manager.setAgentModeMainWindow(fakeWindow as never)
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

beforeEach(() => {
  bodies = []
  toolCall = null
})

async function agentConfig(sessionId: string): Promise<AgentModeTurnConfig> {
  const { harnessSessionId, workspaceDir } = await harness.harnessSessionFor(sessionId, 'Agent')
  return {
    sessionId: harnessSessionId,
    sessionRef: sessionId,
    presetName: 'Agent',
    workspaceDir,
    modelConfig: { source: 'local', model: 'test-model', baseUrl: BACKEND, contextWindow: 8192 },
    toolSpecs: [],
    capabilities: [],
  }
}

async function taskRunConfig(sessionId: string, stepIndex = 1): Promise<AgentModeTurnConfig> {
  const { harnessSessionId, workspaceDir } = await taskRuns.taskRunHarnessFor(sessionId)
  return {
    ...(await agentConfig(sessionId)),
    sessionId: harnessSessionId,
    workspaceDir,
    taskRun: { taskName: 'Morning digest', stepIndex },
  }
}

function userTexts(body: Body | undefined): string[] {
  return (body?.messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
}

function offeredTools(body: Body | undefined): string[] {
  const tools = (body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools
  return (tools ?? []).map((tool) => tool.function?.name ?? '')
}

async function sessionWithHistory() {
  const session = await sessions.createSession()
  await manager.startAgentTurn('t0', 'remember the word plum', await agentConfig(session.id))
  await history.appendHistoryEntry(session.id, {
    preset: 'Draft Image',
    kind: 'image',
    prompt: 'a castle',
    status: 'completed',
    artifacts: [{ path: 'files/castle.png', mediaType: 'image' }],
  })
  bodies = []
  return session
}

describe('a Task Run in its Session', () => {
  it('starts a fresh Harness Session in the Session files folder', async () => {
    const session = await sessions.createSession()
    const agent = await agentConfig(session.id)

    const first = await taskRuns.taskRunHarnessFor(session.id)
    const second = await taskRuns.taskRunHarnessFor(session.id)

    expect(first.harnessSessionId).not.toBe(agent.sessionId)
    expect(second.harnessSessionId).not.toBe(first.harnessSessionId)
    expect(first.workspaceDir).toBe(sessions.sessionPaths(session.id).filesDir)
  }, 30000)

  it('sends its first request with no Session Update, no session_history and no prior turns', async () => {
    const session = await sessionWithHistory()

    await manager.startAgentTurn('t1', 'summarise the news', await taskRunConfig(session.id))

    const body = bodies[0]
    expect(offeredTools(body)).not.toContain('session_history')
    const users = userTexts(body)
    expect(users).toHaveLength(1)
    expect(users[0]).not.toContain('a castle')
    expect(users[0]).not.toContain('Session Update')
    expect(JSON.stringify(body.messages)).not.toContain('plum')
  }, 30000)

  it('appends a History Entry per Step, tagged with the Task name and Step index', async () => {
    const session = await sessions.createSession()
    const step1 = await taskRunConfig(session.id, 1)

    await manager.startAgentTurn('t1', 'first step', step1)
    await manager.startAgentTurn('t2', 'second step', {
      ...step1,
      taskRun: { taskName: 'Morning digest', stepIndex: 2 },
    })

    const entries = await history.readHistoryEntries(session.id)
    expect(entries).toEqual([
      expect.objectContaining({ prompt: 'first step', taskName: 'Morning digest', stepIndex: 1 }),
      expect.objectContaining({ prompt: 'second step', taskName: 'Morning digest', stepIndex: 2 }),
    ])
  }, 30000)

  it("deletes a run's Pi file with the Session", async () => {
    const stop = harness.cleanUpHarnessSessionsOnDelete((id) => manager.deleteAgentSession(id))
    const session = await sessions.createSession()
    const config = await taskRunConfig(session.id)
    await manager.startAgentTurn('t1', 'hello', config)
    const piFile = store.readSessionStore()[config.sessionId]?.sessionFilePath
    expect(piFile && fs.existsSync(piFile)).toBe(true)

    await sessions.deleteSession(session.id)

    expect(fs.existsSync(piFile!)).toBe(false)
    stop()
  }, 30000)
})
