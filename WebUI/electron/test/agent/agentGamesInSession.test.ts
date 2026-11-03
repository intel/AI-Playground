import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'

// Game Agent and Quick Coder inside a Session, seen from outside main: a real Pi
// session runs each turn in a game folder against a fake OpenAI-compatible
// backend served through `fetch`; assertions are on the request bodies Pi sent,
// the Session Folder's files and the game folder.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-game-session-')))

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
  getGamesDir: () => path.join(tempRoot, 'games'),
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

function makeGame(slug: string): string {
  const dir = path.join(tempRoot, 'games', slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), '<canvas></canvas>')
  return dir
}

async function gameConfig(
  sessionId: string,
  presetName: string,
  gameDir?: string,
): Promise<AgentModeTurnConfig> {
  const { harnessSessionId, workspaceDir } = await harness.harnessSessionFor(
    sessionId,
    presetName,
    { kind: 'game', gameDir },
  )
  return {
    sessionId: harnessSessionId,
    sessionRef: sessionId,
    presetName,
    workspaceDir,
    modelConfig: { source: 'local', model: 'test-model', baseUrl: BACKEND, contextWindow: 8192 },
    toolSpecs: [],
    capabilities: [],
  }
}

function transcriptText(body: Body | undefined): string {
  return JSON.stringify(body?.messages ?? [])
}

describe('Game Agent and Quick Coder in a Session', () => {
  it('continues the same game across an Image Gen turn in between', async () => {
    const session = await sessions.createSession()
    const game = makeGame('plum-run')

    const first = await gameConfig(session.id, 'Game Agent', game)
    expect(await manager.startAgentTurn('t1', 'a game about a plum', first)).toEqual({
      success: true,
    })
    await history.appendHistoryEntry(session.id, {
      preset: 'Draft Image',
      kind: 'image',
      prompt: 'a castle',
      status: 'completed',
      artifacts: [{ path: 'files/castle.png', mediaType: 'image' }],
    })
    const second = await gameConfig(session.id, 'Game Agent')
    expect(second).toMatchObject({ sessionId: first.sessionId, workspaceDir: game })
    await manager.startAgentTurn('t2', 'what is it about?', second)

    const lastRequest = transcriptText(bodies.at(-1))
    expect(lastRequest).toContain('a game about a plum')
    expect(lastRequest).toContain('what is it about?')
  }, 30000)

  it("keeps Game Agent's conversation apart from Quick Coder's in the same Session", async () => {
    const session = await sessions.createSession()

    await manager.startAgentTurn(
      't1',
      'one-shot snake',
      await gameConfig(session.id, 'Quick Coder', makeGame('snake')),
    )
    await manager.startAgentTurn(
      't2',
      'a platformer',
      await gameConfig(session.id, 'Game Agent', makeGame('platformer')),
    )

    // Quick Coder's turn may reach it as a Session Update, never as its own conversation.
    const conversation = (bodies.at(-1)?.messages ?? []).filter((m) => m.role !== 'system')
    expect(conversation.map((m) => m.role)).toEqual(['user'])
  }, 30000)

  it('appends a History Entry per turn, filed under its games preset', async () => {
    const session = await sessions.createSession()

    await manager.startAgentTurn(
      't1',
      'build pong',
      await gameConfig(session.id, 'Quick Coder', makeGame('pong')),
    )

    expect(await history.readHistoryEntries(session.id)).toEqual([
      expect.objectContaining({ preset: 'Quick Coder', kind: 'agent', prompt: 'build pong' }),
    ])
  }, 30000)

  it('deletes the Pi file with the Session but never the game folder', async () => {
    const stop = harness.cleanUpHarnessSessionsOnDelete((id) => manager.deleteAgentSession(id))
    const session = await sessions.createSession()
    const game = makeGame('keep-me')
    const config = await gameConfig(session.id, 'Game Agent', game)
    await manager.startAgentTurn('t1', 'hello', config)
    const piFile = store.readSessionStore()[config.sessionId]?.sessionFilePath
    expect(piFile && fs.existsSync(piFile)).toBe(true)

    await sessions.deleteSession(session.id)
    stop()

    expect(fs.existsSync(piFile!)).toBe(false)
    expect(fs.readFileSync(path.join(game, 'index.html'), 'utf8')).toBe('<canvas></canvas>')
  }, 30000)
})
