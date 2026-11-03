import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { KernelEvent } from '@/types/kernelEvents'

const dirs = vi.hoisted(() => ({ real: '', demo: '', media: '' }))

vi.mock('../../persist/userDataPaths.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  net: { fetch: vi.fn() },
  BrowserWindow: class {},
}))

vi.mock('../../adapters/mcp/mcpManager', () => ({
  listMcpServers: () => [],
  getMcpServerStatus: () => ({ state: 'stopped' }),
  invokeMcpServerTool: vi.fn(),
}))

vi.mock('../../artifact/runner', () => ({
  artifactRunActive: () => false,
  cancelActiveArtifactRun: () => {},
  activeArtifactRunId: () => null,
  startArtifactRun: async () => ({ state: 'completed', items: [] }),
}))

const saveChatTurnConversation = vi.hoisted(() => vi.fn(async (_request: unknown) => {}))
vi.mock('../../persist/conversationFiles.ts', () => ({ saveChatTurnConversation }))

const executeChatComfyToolMock = vi.hoisted(() => vi.fn())
vi.mock('../../chat/chatComfyTool.ts', () => ({
  executeChatComfyTool: (...args: unknown[]) => executeChatComfyToolMock(...args),
}))

const { submitChatTurn, setChatEngineDeps, resetChatEngineDepsForTest } =
  await import('../../chat/turnEngine')
const { setChatModelDeps, resetChatModelDepsForTest } = await import('../../chat/chatModelMain')
const { resetChatReadinessForTest } = await import('../../chat/chatReadiness')
const { setKernelEventWindow, resetKernelBusForTest, onKernelEvent } =
  await import('../../kernel/kernelBus')
const { resetOrchestratorForTest } = await import('../../kernel/orchestrator')
const { createSession, readSession, resetSessionsForTest, setSessionDeps, sessionPaths } =
  await import('../../session/sessions')
const { appendHistoryEntry, readHistoryEntries } = await import('../../session/sessionHistory')
const { takeSessionUpdate } = await import('../../session/sessionUpdate')

// ── Fake backend ──────────────────────────────────────────────────────────────

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}`).join('\n\n') + '\n\ndata: [DONE]\n\n'
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

const textReply = (text: string) => [
  { id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] },
  {
    id: '1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  },
]

const toolCall = (name: string, args: string) => [
  {
    id: '1',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }],
        },
      },
    ],
  },
  {
    id: '1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  },
]

type WireMessage = { role: string; content: unknown }
const requests: Array<{ messages: WireMessage[]; tools?: Array<{ function: { name: string } }> }> =
  []

function queueReplies(...replies: unknown[][]) {
  const queue = [...replies]
  requests.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: unknown }) => {
      requests.push(JSON.parse(String(init?.body ?? '{}')))
      const next = queue.shift()
      if (!next) throw new Error('test fetch queue empty')
      return sseResponse(next)
    }),
  )
}

function textOf(message: WireMessage | undefined): string {
  const content = message?.content
  if (typeof content === 'string') return content
  return (content as Array<{ type: string; text?: string }>).map((part) => part.text ?? '').join('')
}

const lastUser = (body: { messages: WireMessage[] }) =>
  body.messages.filter((message) => message.role === 'user').at(-1)

// ── Harness ───────────────────────────────────────────────────────────────────

let events: KernelEvent[]
let detachTap: () => void

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-chat-in-session-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.media = path.join(root, 'media')
})

beforeEach(async () => {
  setSessionDeps({ isDemoMode: () => false })
  resetKernelBusForTest()
  resetChatModelDepsForTest()
  resetChatEngineDepsForTest()
  resetChatReadinessForTest()
  resetOrchestratorForTest()
  saveChatTurnConversation.mockClear()
  executeChatComfyToolMock.mockReset()
  events = []
  detachTap = onKernelEvent((event) => void events.push(event))
  setKernelEventWindow({
    isDestroyed: () => false,
    webContents: { send: () => {} },
  } as unknown as BrowserWindow)
  await fs.mkdir(dirs.media, { recursive: true })
  setChatEngineDeps({
    readMediaAsDataUri: async (url) => `data:image/png;base64,${url.length}`,
    localPathOf: (url) =>
      url.startsWith('aipg-media://media/')
        ? path.join(dirs.media, url.slice('aipg-media://media/'.length))
        : null,
  })
  setChatModelDeps({
    llmApiBase: () => 'http://127.0.0.1:39101',
    ensureBackendReadiness: vi.fn(),
    homeAgentAuthToken: () => 'token',
    readCloudProviderKey: () => null,
  })
})

afterEach(async () => {
  detachTap()
  vi.unstubAllGlobals()
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.media, { recursive: true, force: true })
})

async function runTurn(request: Record<string, unknown>): Promise<void> {
  const { turnId } = submitChatTurn({
    conversationKey: 'session-chat',
    trigger: 'submit-message',
    systemPrompt: 'You are helpful.',
    model: {
      backend: 'llamaCPP',
      modelId: 'test/model.gguf',
      baseUrl: 'http://127.0.0.1:39101',
      maxOutputTokens: 100,
      temperature: 0.7,
    },
    tools: [],
    persist: { meta: null, ragHashes: [] },
    presetName: 'Basic Chat',
    ...request,
  })
  await vi.waitFor(() => {
    expect(events.some((event) => event.type === 'chat-turn-done' && event.turnId === turnId)).toBe(
      true,
    )
  })
}

const user = (id: string, text: string) => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})

const imageEntry = {
  preset: 'Image Gen',
  kind: 'image' as const,
  prompt: 'a red fox',
  status: 'completed' as const,
  artifacts: [{ path: 'files/fox.png', mediaType: 'image' as const }],
}

type TimelineMessage = {
  id: string
  role: string
  parts: Array<{ type: string; text?: string; output?: unknown }>
  metadata?: { sessionUpdate?: string; chatTurn?: unknown }
}

async function timelineOf(sessionId: string): Promise<TimelineMessage[]> {
  return (await readSession(sessionId)).timeline as TimelineMessage[]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('a chat turn in a Session', () => {
  it('prepends the Session Update to the user message, not the system prompt', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageEntry)
    queueReplies(textReply('A fox.'))

    await runTurn({ sessionRef: id, messages: [user('u1', 'describe the image')] })

    const body = requests[0]
    expect(textOf(body.messages[0])).not.toContain('a red fox')
    const sent = textOf(lastUser(body))
    expect(sent).toMatch(/^Session Update/)
    expect(sent).toContain('Image Gen: "a red fox" → files/fox.png')
    expect(sent.endsWith('describe the image')).toBe(true)
  })

  it('stores the update in the transcript and resends it byte-identically next turn', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageEntry)
    queueReplies(textReply('A fox.'), textReply('Orange.'))

    await runTurn({ sessionRef: id, messages: [user('u1', 'describe the image')] })
    const firstSent = textOf(lastUser(requests[0]))
    const stored = (await timelineOf(id)).find((message) => message.id === 'u1')
    expect(stored?.metadata?.sessionUpdate).toContain('a red fox')
    expect(stored?.parts).toEqual([{ type: 'text', text: 'describe the image' }])

    const assistant = (await timelineOf(id)).find((message) => message.role === 'assistant')
    // The renderer's live copy never carries the stored update.
    await runTurn({
      sessionRef: id,
      messages: [
        user('u1', 'describe the image'),
        { ...assistant, metadata: {} },
        user('u2', 'what colour?'),
      ],
    })
    const second = requests[1]
    const users = second.messages.filter((message) => message.role === 'user')
    expect(textOf(users[0])).toBe(firstSent)
    expect(textOf(users[1])).toBe('what colour?')
  })

  it('keeps the chat cursor apart from an agent preset’s', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageEntry)
    expect(await takeSessionUpdate(id, { key: 'harness-a', ownPreset: 'Agent' })).toContain(
      'a red fox',
    )
    queueReplies(textReply('A fox.'), textReply('Still a fox.'))

    await runTurn({ sessionRef: id, messages: [user('u1', 'describe the image')] })
    expect(textOf(lastUser(requests[0]))).toContain('a red fox')

    await runTurn({ sessionRef: id, messages: [user('u2', 'again')] })
    expect(textOf(lastUser(requests[1]))).toBe('again')
  })

  it('appends a chat History Entry with the response, and keeps it out of its own update', async () => {
    const { id } = await createSession()
    queueReplies(textReply('Hello there.'))

    await runTurn({ sessionRef: id, messages: [user('u1', 'hi')] })

    const entries = await readHistoryEntries(id)
    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'chat',
        preset: 'Basic Chat',
        prompt: 'hi',
        status: 'completed',
        response: 'Hello there.',
        artifacts: [],
      }),
    ])
    expect(await takeSessionUpdate(id, { key: 'chat', isOwn: (e) => e.kind === 'chat' })).toBe(null)
    const session = await readSession(id)
    expect(session.title).toBe('hi')
    expect(session.presetsUsed).toContain('Basic Chat')
    expect(saveChatTurnConversation).not.toHaveBeenCalled()
  })

  it('replaces a regenerated reply where it stood and leaves other turns alone', async () => {
    const { id } = await createSession()
    queueReplies(textReply('First.'), textReply('Second.'))
    await runTurn({ sessionRef: id, messages: [user('u1', 'hi')] })

    await runTurn({
      sessionRef: id,
      trigger: 'regenerate-message',
      messages: [user('u1', 'hi')],
    })

    const timeline = await timelineOf(id)
    expect(timeline.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(timeline[1].parts.some((part) => part.text === 'Second.')).toBe(true)
  })

  it('moves Agentic Chat media into files/ and lists it on the History Entry', async () => {
    const { id } = await createSession()
    await fs.writeFile(path.join(dirs.media, 'cat.png'), 'png')
    executeChatComfyToolMock.mockResolvedValue({
      images: [{ id: 'i1', type: 'image', imageUrl: 'aipg-media://media/cat.png' }],
    })
    queueReplies(toolCall('comfyUI', '{"prompt":"a cat"}'), textReply('Here is a cat.'))

    await runTurn({
      sessionRef: id,
      messages: [user('u1', 'draw a cat')],
      tools: [{ name: 'comfyUI', description: 'draw', inputSchema: { type: 'object' } }],
    })

    const [entry] = await readHistoryEntries(id)
    expect(entry.artifacts).toEqual([{ path: 'files/cat.png', mediaType: 'image' }])
    await expect(
      fs.readFile(path.join(sessionPaths(id).filesDir, 'cat.png'), 'utf8'),
    ).resolves.toBe('png')
    const toolPart = (await timelineOf(id))
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool-comfyUI')
    expect(JSON.stringify(toolPart?.output)).toContain(`aipg-media://sessions/${id}/files/cat.png`)
  })

  it('offers session_history only when the renderer sends it, and answers list', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageEntry)
    queueReplies(toolCall('session_history', '{"action":"list"}'), textReply('One image.'))

    await runTurn({
      sessionRef: id,
      messages: [user('u1', 'what happened?')],
      tools: [{ name: 'session_history', description: 'history', inputSchema: { type: 'object' } }],
    })

    expect(requests[0].tools?.map((tool) => tool.function.name)).toEqual(['session_history'])
    const toolResult = requests[1].messages.find((message) => message.role === 'tool')
    expect(JSON.stringify(toolResult?.content)).toContain('a red fox')
  })
})
