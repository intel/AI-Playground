import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { KernelEvent } from '@/types/kernelEvents'

// Which Agent Session an agent turn belongs to, as seen from outside main: the
// kernel events it streams, the snapshot a reconnecting renderer hydrates from,
// and what a cancel by session reaches. A real Pi session runs each turn against
// a fake OpenAI-compatible backend served through `fetch` (this keeps the test
// independent of loopback sockets), so the assertions are on what Pi actually
// asked for and what the bus actually carried.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-turn-sessions-')))

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

const BACKEND = 'http://fake-llm.test/v1'

type Pending = { body: Record<string, unknown>; release: () => void }

/** Requests the fake backend received, each held until released. */
let pending: Pending[] = []
let autoRelease = true
let onRequest: () => void = () => {}

function sseResponse(signal: AbortSignal | null | undefined, gate: Promise<void>): Response {
  const encoder = new TextEncoder()
  const frame = (chunk: unknown) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
  const completion = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const body = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const aborted = new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      )
      await Promise.race([gate, aborted])
      if (signal?.aborted) {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'))
        return
      }
      controller.enqueue(frame(completion({ role: 'assistant', content: 'done' })))
      controller.enqueue(frame(completion({}, 'stop')))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    if (!request.url.startsWith(BACKEND)) return realFetch(input, init)
    const text = await request.text()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    pending.push({ body: text ? JSON.parse(text) : {}, release })
    if (autoRelease) release()
    onRequest()
    return sseResponse(init?.signal ?? request.signal, gate)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let events: KernelEvent[] = []
let workspace: string

type Manager = typeof import('../../agent/piAgentManager')
let manager: Manager
let bus: typeof import('../../kernel/kernelBus')

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  bus = await import('../../kernel/kernelBus')
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: { send: (_channel: string, event: KernelEvent) => void events.push(event) },
  }
  bus.setKernelEventWindow(fakeWindow as never)
  manager.setAgentModeMainWindow(fakeWindow as never)
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

beforeEach(() => {
  events = []
  pending = []
  autoRelease = true
  onRequest = () => {}
  workspace = fs.mkdtempSync(path.join(tempRoot, 'ws-'))
})

function configFor(sessionId: string): AgentModeTurnConfig {
  return {
    sessionId,
    workspaceDir: workspace,
    modelConfig: { source: 'local', model: 'test-model', baseUrl: BACKEND, contextWindow: 8192 },
    toolSpecs: [],
    capabilities: [],
  }
}

function agentEvents(): KernelEvent[] {
  return events.filter((event) => event.type.startsWith('agent-'))
}

/** Resolves with the next request the backend receives. */
function nextRequest(): Promise<void> {
  return new Promise((resolve) => {
    onRequest = resolve
  })
}

describe('agent turns, told apart by Agent Session', () => {
  it('stamps every event of a turn with its session id and turn id', async () => {
    const turnId = crypto.randomUUID()
    const result = await manager.startAgentTurn(turnId, 'hello', configFor('aipg-agent-a'))

    expect(result).toEqual({ success: true })
    expect(pending).toHaveLength(1)
    const emitted = agentEvents()
    expect(emitted.some((event) => event.type === 'agent-chunk')).toBe(true)
    expect(emitted.at(-1)?.type).toBe('agent-turn-done')
    for (const event of emitted) {
      expect(event).toMatchObject({ sessionId: 'aipg-agent-a', turnId })
    }
  }, 30000)

  it('lists the open turn in the kernel snapshot while it runs, and drops it once done', async () => {
    autoRelease = false
    const turnId = crypto.randomUUID()
    const requested = nextRequest()
    const turn = manager.startAgentTurn(turnId, 'hello', configFor('aipg-agent-a'))
    await requested

    expect(bus.getKernelSnapshot().state.agentTurns).toEqual([
      expect.objectContaining({ sessionId: 'aipg-agent-a', turnId, state: 'running' }),
    ])

    pending[0].release()
    await turn
    expect(bus.getKernelSnapshot().state.agentTurns).toEqual([])
  }, 30000)

  it('cancels by session: another session or turn id reaches nothing', async () => {
    autoRelease = false
    const turnId = crypto.randomUUID()
    const requested = nextRequest()
    const turn = manager.startAgentTurn(turnId, 'hello', configFor('aipg-agent-a'))
    await requested

    manager.cancelAgentTurn('aipg-agent-b')
    manager.cancelAgentTurn('aipg-agent-a', crypto.randomUUID())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(agentEvents().some((event) => event.type === 'agent-turn-done')).toBe(false)

    manager.cancelAgentTurn('aipg-agent-a', turnId)
    await turn
    expect(agentEvents().filter((event) => event.type === 'agent-turn-done')).toEqual([
      expect.objectContaining({ sessionId: 'aipg-agent-a', turnId }),
    ])
    expect(bus.getKernelSnapshot().state.agentTurns).toEqual([])
  }, 30000)

  it("queues another session's turn and sends its first request only after the first turn ends", async () => {
    autoRelease = false
    const first = crypto.randomUUID()
    const requested = nextRequest()
    const turnA = manager.startAgentTurn(first, 'hello', configFor('aipg-agent-a'))
    await requested

    const second = crypto.randomUUID()
    const turnB = manager.startAgentTurn(second, 'and you', configFor('aipg-agent-b'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pending).toHaveLength(1)
    expect(bus.getKernelSnapshot().state.agentTurns).toEqual([
      expect.objectContaining({ sessionId: 'aipg-agent-a', turnId: first, state: 'running' }),
      expect.objectContaining({ sessionId: 'aipg-agent-b', turnId: second, state: 'queued' }),
    ])

    const requestedB = nextRequest()
    pending[0].release()
    expect(await turnA).toEqual({ success: true })
    const doneA = events.findIndex(
      (event) => event.type === 'agent-turn-done' && event.turnId === first,
    )
    await requestedB
    expect(pending).toHaveLength(2)
    const runningB = events.findIndex(
      (event) =>
        event.type === 'agent-turn-state' && event.turnId === second && event.state === 'running',
    )
    expect(runningB).toBeGreaterThan(doneA)

    pending[1].release()
    expect(await turnB).toEqual({ success: true })
    for (const event of agentEvents()) {
      const sessionId =
        (event as { turnId?: string }).turnId === first ? 'aipg-agent-a' : 'aipg-agent-b'
      expect(event).toMatchObject({ sessionId })
    }
  }, 30000)

  it('refuses a second turn for the same session while one is in flight', async () => {
    autoRelease = false
    const first = crypto.randomUUID()
    const requested = nextRequest()
    const turn = manager.startAgentTurn(first, 'hello', configFor('aipg-agent-a'))
    await requested

    expect(
      await manager.startAgentTurn(crypto.randomUUID(), 'again', configFor('aipg-agent-a')),
    ).toEqual({ success: false, error: 'This session already has a turn in flight.' })

    pending[0].release()
    await turn
    expect(pending).toHaveLength(1)
  }, 30000)

  it("refuses another Harness Session's turn in the same Session, while another Session queues", async () => {
    autoRelease = false
    const inSession = (harness: string, sessionRef: string) => ({
      ...configFor(harness),
      sessionRef,
      presetName: 'Agent',
    })
    const first = crypto.randomUUID()
    const requested = nextRequest()
    const turnA = manager.startAgentTurn(first, 'hello', inSession('aipg-agent-a', 'session-1'))
    await requested

    expect(
      await manager.startAgentTurn(
        crypto.randomUUID(),
        'again',
        inSession('aipg-agent-b', 'session-1'),
      ),
    ).toEqual({ success: false, error: 'This Session already has a turn in flight.' })

    const other = crypto.randomUUID()
    const turnC = manager.startAgentTurn(other, 'elsewhere', inSession('aipg-agent-c', 'session-2'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(bus.getKernelSnapshot().state.agentTurns).toEqual([
      expect.objectContaining({ sessionId: 'aipg-agent-a', state: 'running' }),
      expect.objectContaining({ sessionId: 'aipg-agent-c', state: 'queued' }),
    ])
    expect(Object.keys(bus.getKernelSnapshot().state.sessionTurns ?? {}).sort()).toEqual([
      'session-1',
      'session-2',
    ])

    const requestedC = nextRequest()
    pending[0].release()
    expect(await turnA).toEqual({ success: true })
    await requestedC
    pending[1].release()
    expect(await turnC).toEqual({ success: true })
    expect(bus.getKernelSnapshot().state.sessionTurns).toEqual({})
  }, 30000)

  it('cancels a queued turn without it ever reaching the backend, leaving the running one alone', async () => {
    autoRelease = false
    const first = crypto.randomUUID()
    const requested = nextRequest()
    const turnA = manager.startAgentTurn(first, 'hello', configFor('aipg-agent-a'))
    await requested

    const second = crypto.randomUUID()
    const turnB = manager.startAgentTurn(second, 'and you', configFor('aipg-agent-b'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    manager.cancelAgentTurn('aipg-agent-b')
    expect((await turnB).success).toBe(false)
    expect(events.filter((event) => event.type === 'agent-turn-done')).toEqual([
      expect.objectContaining({ sessionId: 'aipg-agent-b', turnId: second }),
    ])
    expect(events.some((event) => event.type === 'agent-chunk' && event.turnId === second)).toBe(
      false,
    )

    pending[0].release()
    expect(await turnA).toEqual({ success: true })
    expect(pending).toHaveLength(1)
  }, 30000)

  it('stops a queued turn of a session that is deleted', async () => {
    autoRelease = false
    const first = crypto.randomUUID()
    const requested = nextRequest()
    const turnA = manager.startAgentTurn(first, 'hello', configFor('aipg-agent-a'))
    await requested

    const second = crypto.randomUUID()
    const turnB = manager.startAgentTurn(second, 'and you', configFor('aipg-agent-b'))
    expect(await manager.deleteAgentSession('aipg-agent-b')).toEqual({ success: true })
    expect((await turnB).success).toBe(false)

    pending[0].release()
    await turnA
    expect(pending).toHaveLength(1)
    expect(manager.isAgentTurnActive()).toBe(false)
  }, 30000)

  it('stops the open turn of a session that is deleted', async () => {
    autoRelease = false
    const turnId = crypto.randomUUID()
    const requested = nextRequest()
    const turn = manager.startAgentTurn(turnId, 'hello', configFor('aipg-agent-a'))
    await requested

    expect(await manager.deleteAgentSession('aipg-agent-a')).toEqual({ success: true })
    await turn
    expect(agentEvents().at(-1)).toMatchObject({
      type: 'agent-turn-done',
      sessionId: 'aipg-agent-a',
      turnId,
    })
    expect(manager.isAgentTurnActive()).toBe(false)
  }, 30000)
})
