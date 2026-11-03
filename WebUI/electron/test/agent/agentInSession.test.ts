import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'

// The Agent preset inside a Session, seen from outside main: a real Pi session
// runs each turn against a fake OpenAI-compatible backend served through
// `fetch`, so the assertions are on the request bodies Pi sent and on the
// Session Folder's own files.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-agent-session-')))

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

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  sessions = await import('../../session/sessions')
  harness = await import('../../session/sessionHarness')
  history = await import('../../session/sessionHistory')
  store = await import('../../agent/piSessionStore')
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

function transcriptText(body: Body | undefined): string {
  return JSON.stringify(body?.messages ?? [])
}

describe('the Agent preset in a Session', () => {
  it('continues one Harness Session across a panel turn in between', async () => {
    const session = await sessions.createSession()

    const first = await agentConfig(session.id)
    expect(await manager.startAgentTurn('t1', 'remember the word plum', first)).toEqual({
      success: true,
    })
    await history.appendHistoryEntry(session.id, {
      preset: 'Draft Image',
      kind: 'image',
      prompt: 'a castle',
      status: 'completed',
      artifacts: [{ path: 'files/castle.png', mediaType: 'image' }],
    })
    const second = await agentConfig(session.id)
    expect(second.sessionId).toBe(first.sessionId)
    expect(await manager.startAgentTurn('t2', 'which word?', second)).toEqual({ success: true })

    const lastRequest = transcriptText(bodies.at(-1))
    expect(lastRequest).toContain('remember the word plum')
    expect(lastRequest).toContain('reply 1')
    expect(lastRequest).toContain('which word?')
  }, 30000)

  it('appends one History Entry per settled agent turn, with its full response', async () => {
    const session = await sessions.createSession()

    await manager.startAgentTurn('t1', 'build a page', await agentConfig(session.id))

    expect(await history.readHistoryEntries(session.id)).toEqual([
      expect.objectContaining({
        preset: 'Agent',
        kind: 'agent',
        prompt: 'build a page',
        status: 'completed',
        response: 'reply 1',
        artifacts: [],
      }),
    ])
  }, 30000)

  it('names an untitled Session after its first prompt and lists the preset as used', async () => {
    const session = await sessions.createSession()

    await manager.startAgentTurn('t1', 'build a landing page', await agentConfig(session.id))

    expect(await sessions.openSession(session.id)).toMatchObject({
      title: 'build a landing page',
      presetsUsed: ['Agent'],
    })
  }, 30000)

  it('works in the Session files folder, and its file tools cannot read the history', async () => {
    const session = await sessions.createSession()
    await history.appendHistoryEntry(session.id, {
      preset: 'Draft Image',
      kind: 'image',
      prompt: 'SECRET-PLUM',
      status: 'completed',
      artifacts: [],
    })
    const config = await agentConfig(session.id)
    expect(config.workspaceDir).toBe(sessions.sessionPaths(session.id).filesDir)
    toolCall = { name: 'read', args: { path: '../session-history.jsonl' } }

    await manager.startAgentTurn('t1', 'read the history file', config)

    const toolMessages = (bodies.at(-1)?.messages ?? []).filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(JSON.stringify(toolMessages)).not.toContain('SECRET-PLUM')
  }, 30000)

  it("deletes the Harness Session's Pi file with the Session", async () => {
    const stop = harness.cleanUpHarnessSessionsOnDelete((id) => manager.deleteAgentSession(id))
    const session = await sessions.createSession()
    const config = await agentConfig(session.id)
    await manager.startAgentTurn('t1', 'hello', config)
    const piFile = store.readSessionStore()[config.sessionId]?.sessionFilePath
    expect(piFile && fs.existsSync(piFile)).toBe(true)

    await sessions.deleteSession(session.id)

    expect(fs.existsSync(piFile!)).toBe(false)
    expect(store.readSessionStore()[config.sessionId]).toBeUndefined()
    stop()
  }, 30000)
})

function userTexts(body: Body | undefined): string[] {
  return (body?.messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
}

describe('the Session Update and session_history for an agent preset', () => {
  async function sessionWithCastle() {
    const session = await sessions.createSession()
    await history.appendHistoryEntry(session.id, {
      preset: 'Draft Image',
      kind: 'image',
      prompt: 'a castle',
      status: 'completed',
      artifacts: [{ path: 'files/castle.png', mediaType: 'image' }],
    })
    return session
  }

  it('prepends what it missed to the user message, never the system prompt', async () => {
    const session = await sessionWithCastle()

    await manager.startAgentTurn('t1', 'describe that image', await agentConfig(session.id))

    const body = bodies[0]
    expect(body.messages?.[0].role).toBe('system')
    expect(JSON.stringify(body.messages?.[0].content)).not.toContain('a castle')
    const user = userTexts(body).at(-1)!
    expect(user).toMatch(/Draft Image: \\?"a castle\\?" → castle\.png/)
    expect(user.indexOf('a castle')).toBeLessThan(user.indexOf('describe that image'))
    expect(await history.readHistoryEntries(session.id)).toContainEqual(
      expect.objectContaining({ preset: 'Agent', prompt: 'describe that image' }),
    )
  }, 30000)

  it("reports a Task Run's Steps, which ran under the same preset in another Harness Session", async () => {
    const session = await sessions.createSession()
    await manager.startAgentTurn('t1', 'hello', await agentConfig(session.id))
    await history.appendHistoryEntry(session.id, {
      preset: 'Agent',
      kind: 'agent',
      prompt: 'summarize the inbox',
      status: 'completed',
      artifacts: [],
      response: 'Three new mails.',
      taskName: 'Morning digest',
      stepIndex: 1,
    })
    bodies = []

    await manager.startAgentTurn('t2', 'what did the task find?', await agentConfig(session.id))

    expect(userTexts(bodies[0]).at(-1)).toContain('summarize the inbox')
  }, 30000)

  it('sends no update when nothing happened since its last turn', async () => {
    const session = await sessionWithCastle()
    await manager.startAgentTurn('t1', 'describe that image', await agentConfig(session.id))
    bodies = []

    await manager.startAgentTurn('t2', 'and now?', await agentConfig(session.id))

    const users = userTexts(bodies[0])
    expect(users.at(-1)).not.toContain('Session Update')
    expect(users.filter((text) => text.includes('Session Update'))).toHaveLength(1)
  }, 30000)

  it('offers session_history, which answers from the Session History', async () => {
    const session = await sessionWithCastle()
    toolCall = { name: 'session_history', args: { action: 'list' } }

    await manager.startAgentTurn('t1', 'what happened here?', await agentConfig(session.id))

    const offered = (bodies[0] as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    expect(offered.map((tool) => tool.function?.name)).toContain('session_history')
    const toolMessages = (bodies.at(-1)?.messages ?? []).filter((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessages)).toContain('a castle')
    expect(JSON.stringify(toolMessages)).toContain('Draft Image')
  }, 30000)
})
