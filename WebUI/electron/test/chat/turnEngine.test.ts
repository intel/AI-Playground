import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { KernelEvent } from '@/types/kernelEvents'
import type { UIMessageChunk } from 'ai'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../adapters/mcp/mcpManager', () => ({
  listMcpServers: vi.fn(),
  getMcpServerStatus: vi.fn(),
  invokeMcpServerTool: vi.fn(),
}))

const webBrowserMock = vi.hoisted(() => ({
  search: vi.fn(),
  navigate: vi.fn(),
  interact: vi.fn(),
  screenshot: vi.fn(),
  getState: vi.fn(() => ({ isOpen: false, isVisible: false, currentUrl: '', title: '' })),
}))
vi.mock('../../adapters/webBrowserManager', () => webBrowserMock)

const captureWindowMock = vi.hoisted(() => vi.fn())
vi.mock('../../adapters/hardware/screenCapture', () => ({
  captureWindow: (...args: unknown[]) => captureWindowMock(...args),
}))

vi.mock('../../artifact/runner', () => ({
  artifactRunActive: () => false,
  cancelActiveArtifactRun: () => {},
  activeArtifactRunId: () => null,
  startArtifactRun: async () => ({ state: 'completed', items: [] }),
}))

const { saveChatTurnConversation } = vi.hoisted(() => ({
  saveChatTurnConversation: vi.fn(async (_request: unknown) => {}),
}))

vi.mock('../../persist/conversationFiles.ts', () => ({
  saveChatTurnConversation,
}))

const runMediaAgentInMainMock = vi.hoisted(() => vi.fn())
vi.mock('../../chat/mediaAgentRunner.ts', () => ({
  runMediaAgentInMain: (...args: unknown[]) => runMediaAgentInMainMock(...args),
  cancelMediaAgentRun: vi.fn(),
  activeMediaAgentRunKeys: () => [],
}))

const executeChatComfyToolMock = vi.hoisted(() => vi.fn())
vi.mock('../../chat/chatComfyTool.ts', () => ({
  executeChatComfyTool: (...args: unknown[]) => executeChatComfyToolMock(...args),
}))

const executeChatSpeechToolMock = vi.hoisted(() =>
  vi.fn<(options: { toolName: string; messages?: unknown }) => Promise<unknown>>(),
)
vi.mock('../../chat/chatSpeechTools.ts', async () => {
  const actual = await vi.importActual<typeof import('../../chat/chatSpeechTools')>(
    '../../chat/chatSpeechTools',
  )
  return {
    ...actual,
    executeChatSpeechTool: (options: { toolName: string }) => executeChatSpeechToolMock(options),
  }
})

const {
  submitChatTurn,
  cancelChatTurn,
  chatTurnActive,
  resumeChatTurn,
  setChatEngineDeps,
  resetChatEngineDepsForTest,
  buildToolSet,
} = await import('../../chat/turnEngine')
const { setChatModelDeps, resetChatModelDepsForTest } = await import('../../chat/chatModelMain')
const {
  resetChatReadinessForTest,
  setChatReadinessDeps,
  ensureChatBackendReady,
  reloadLastChatBackend,
} = await import('../../chat/chatReadiness')
const { setKernelEventWindow, resetKernelBusForTest, onKernelEvent } =
  await import('../../kernel/kernelBus')
const { handleChatAnswer, resetChatAskForTest } = await import('../../chat/chatAsk')
const { listMcpServers, getMcpServerStatus, invokeMcpServerTool } =
  await import('../../adapters/mcp/mcpManager')
const { resetOrchestratorForTest } = await import('../../kernel/orchestrator')

type SentPayload = Record<string, unknown> & { channel?: string }

function fakeWindow(): { win: BrowserWindow; sent: SentPayload[] } {
  const sent: SentPayload[] = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: SentPayload) => void sent.push({ channel, ...payload }),
    },
  } as unknown as BrowserWindow
  return { win, sent }
}

// ── SSE fixtures ───────────────────────────────────────────────────────────────

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}`).join('\n\n') + '\n\ndata: [DONE]\n\n'
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function textChunks(text: string) {
  return [
    { id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] },
    {
      id: '1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      timings: {
        cache_n: 1,
        prompt_n: 3,
        prompt_ms: 30,
        prompt_per_token_ms: 10,
        prompt_per_second: 100,
        predicted_n: 2,
        predicted_ms: 100,
        predicted_per_token_ms: 50,
        predicted_per_second: 20,
      },
    },
  ]
}

function toolCallChunks(name: string, args: string) {
  return [
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
}

// ── Signal-aware fetch queue ───────────────────────────────────────────────────

type ResponseFactory = (signal?: AbortSignal) => Response

const sse =
  (chunks: unknown[]): ResponseFactory =>
  () =>
    sseResponse(chunks)

/** A stream that never yields; its reads reject with AbortError once cancelled. */
const pending = (): ResponseFactory => (signal) => {
  const stream = new ReadableStream<Uint8Array>({
    pull: () =>
      new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('This operation was aborted', 'AbortError'))
          return
        }
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        )
      }),
    cancel: () => {},
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const requests: Array<{ url: string; body: Record<string, unknown> }> = []
let responses: ResponseFactory[] = []

function queueFetchMock(...queued: ResponseFactory[]) {
  responses = queued
  requests.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: unknown; signal?: AbortSignal }) => {
      requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
      const factory = responses.shift()
      if (!factory) throw new Error('test fetch queue empty')
      return factory(init?.signal)
    }),
  )
}

// ── Turn request fixture ───────────────────────────────────────────────────────

function turnRequest(overrides: Record<string, unknown> = {}) {
  return {
    conversationKey: 'conv-1',
    trigger: 'submit-message',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    systemPrompt: 'You are helpful.',
    model: {
      backend: 'llamaCPP',
      modelId: 'test/model.gguf',
      baseUrl: 'http://127.0.0.1:39101',
      timingsPerToken: true,
      maxOutputTokens: 100,
      temperature: 0.7,
    },
    tools: [],
    ...overrides,
  }
}

/** The Home Agent inference picture a turn ships when that preset is active. */
function homeAgentSnapshot() {
  return {
    backend: 'llamaCPP' as const,
    current: {
      model: 'qwen-9b',
      embeddingModel: 'bge-small',
      deviceId: 'GPU.0',
      temperature: 0.7,
      maxTokens: 1024,
      contextSize: 8192,
      systemPrompt: 'You are helpful.',
      aipgToolsEnabled: true,
      mcpToolsEnabled: false,
      metricsEnabled: false,
      ragDocumentCount: 0,
    },
    llmModels: {
      llamaCPP: [{ name: 'qwen-9b', downloaded: true, maxContextSize: 32768 }],
      openVINO: [],
      cloud: [],
    },
    embeddingModels: [{ name: 'bge-small', downloaded: true }],
    devices: { llamaCPP: [{ id: 'GPU.0', name: 'Intel Arc' }], openVINO: [] },
  }
}

// ── Harness ────────────────────────────────────────────────────────────────────

let events: KernelEvent[]
let detachTap: () => void
let sent: SentPayload[]
let readMediaAsDataUri: ReturnType<typeof vi.fn<(url: string) => Promise<string>>>

beforeEach(() => {
  resetKernelBusForTest()
  resetChatAskForTest()
  resetChatModelDepsForTest()
  resetChatEngineDepsForTest()
  resetChatReadinessForTest()
  resetOrchestratorForTest()
  saveChatTurnConversation.mockClear()
  events = []
  detachTap = onKernelEvent((event) => void events.push(event))
  const window = fakeWindow()
  sent = window.sent
  setKernelEventWindow(window.win)
  readMediaAsDataUri = vi.fn(async (url: string) => `data:image/png;base64,${url.length}`)
  setChatEngineDeps({ readMediaAsDataUri })
  setChatModelDeps({
    llmApiBase: () => 'http://127.0.0.1:39101',
    ensureBackendReadiness: vi.fn(),
    homeAgentAuthToken: () => 'token',
    cloudProxyAuthToken: () => 'cloud-token',
  })
  vi.mocked(listMcpServers).mockReturnValue([])
  vi.mocked(getMcpServerStatus).mockReturnValue({ state: 'stopped' } as never)
  vi.mocked(invokeMcpServerTool).mockReset()
  webBrowserMock.navigate.mockReset()
  webBrowserMock.search.mockReset()
  webBrowserMock.interact.mockReset()
  webBrowserMock.screenshot.mockReset()
  captureWindowMock.mockReset()
  runMediaAgentInMainMock.mockReset()
  executeChatComfyToolMock.mockReset()
  executeChatComfyToolMock.mockResolvedValue({ images: [] })
  executeChatSpeechToolMock.mockReset()
  executeChatSpeechToolMock.mockResolvedValue({ ok: true, message: 'done' })
})

afterEach(() => {
  detachTap()
  vi.unstubAllGlobals()
})

function chatChunks(): UIMessageChunk[] {
  return events.filter((e) => e.type === 'chat-chunk').map((e) => e.chunk as UIMessageChunk)
}

function doneTurnIds(): string[] {
  return events
    .filter((e) => e.type === 'chat-turn-done')
    .map((e) => (e as { turnId: string }).turnId)
}

function textQueueEvents() {
  return events
    .filter((e): e is Extract<KernelEvent, { type: 'queue-event' }> => e.type === 'queue-event')
    .filter((e) => e.kind === 'text')
}

async function waitForTurnDone(turnId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(doneTurnIds()).toContain(turnId)
  })
}

function bodyMessages(): Array<{ role: string; content: unknown }> {
  return requests[0].body.messages as Array<{ role: string; content: unknown }>
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('turn engine', () => {
  it('streams a text turn over the kernel bus, coalescing adjacent deltas', async () => {
    queueFetchMock(
      sse([
        ...textChunks('Hello').slice(0, 1),
        ...textChunks(' world').slice(0, 1),
        ...textChunks('').slice(1),
      ]),
    )
    const { turnId } = submitChatTurn(turnRequest())
    await waitForTurnDone(turnId)

    const chunks = chatChunks()
    const deltas = chunks.filter((c) => c.type === 'text-delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ type: 'text-delta', delta: 'Hello world' })
    expect(chunks.some((c) => c.type === 'finish')).toBe(true)

    expect(requests[0].body).toMatchObject({
      model: 'test---model.gguf',
      timings_per_token: true,
      temperature: 0.7,
      max_tokens: 100,
    })
    expect(bodyMessages()[0]).toMatchObject({ role: 'system', content: 'You are helpful.' })
    expect(chatTurnActive('conv-1')).toBe(false)
  })

  it('loads the local backend from the turn request before streaming', async () => {
    const ensureBackendReadiness = vi.fn(async () => {})
    const awaitChatWindow = vi.fn(async () => {})
    const stopOvmsImageServer = vi.fn(async () => {})
    setChatReadinessDeps({
      getService: () => ({ ensureBackendReadiness, baseUrl: 'http://127.0.0.1:39101' }),
      awaitChatWindow,
      stopOvmsImageServer,
      notifyHomeAgentUpstreamReady: vi.fn(),
    })
    queueFetchMock(sse(textChunks('ok')))
    const base = turnRequest()
    const { turnId } = submitChatTurn({
      ...base,
      model: {
        ...base.model,
        readiness: {
          serviceName: 'llamacpp-backend',
          llmModelName: 'test/model.gguf',
        },
      },
    })
    await waitForTurnDone(turnId)

    expect(awaitChatWindow).not.toHaveBeenCalled()
    expect(stopOvmsImageServer).toHaveBeenCalledTimes(1)
    expect(ensureBackendReadiness).toHaveBeenCalledWith(
      'test/model.gguf',
      undefined,
      undefined,
      undefined,
    )
    expect(textQueueEvents().map((e) => e.action)).toEqual(['enqueued', 'started', 'finished'])
  })

  it('disarms last-load swap-back on a cloud turn without forgetting the snapshot', async () => {
    const ensureBackendReadiness = vi.fn(async () => {})
    setChatReadinessDeps({
      getService: () => ({ ensureBackendReadiness, baseUrl: 'http://127.0.0.1:39101' }),
      awaitChatWindow: vi.fn(async () => {}),
      stopOvmsImageServer: vi.fn(async () => {}),
      notifyHomeAgentUpstreamReady: vi.fn(),
    })
    await ensureChatBackendReady({
      serviceName: 'llamacpp-backend',
      llmModelName: 'test/model.gguf',
    })
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn({
      ...turnRequest(),
      model: {
        backend: 'cloud',
        modelId: 'gpt-4o',
        baseUrl: 'http://127.0.0.1:39101',
      },
    })
    await waitForTurnDone(turnId)

    ensureBackendReadiness.mockClear()
    await reloadLastChatBackend()
    expect(ensureBackendReadiness).not.toHaveBeenCalled()

    await ensureChatBackendReady({
      serviceName: 'llamacpp-backend',
      llmModelName: 'test/model.gguf',
    })
    ensureBackendReadiness.mockClear()
    await reloadLastChatBackend()
    expect(ensureBackendReadiness).toHaveBeenCalledTimes(1)
  })

  it('carries model + llama.cpp timings into message metadata', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(turnRequest())
    await waitForTurnDone(turnId)

    const chunks = chatChunks()
    const start = chunks.find((c) => c.type === 'start') as
      { messageMetadata?: { model?: string } } | undefined
    const finish = chunks.find((c) => c.type === 'finish') as
      { messageMetadata?: Record<string, unknown> } | undefined
    expect(start?.messageMetadata?.model).toBe('test/model.gguf')
    expect(finish?.messageMetadata?.timings).toMatchObject({ prompt_n: 3, predicted_n: 2 })
    expect(finish?.messageMetadata?.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 })
  })

  it('rejects a second turn for the same conversation but allows another one', async () => {
    queueFetchMock(pending(), pending())
    const first = submitChatTurn(turnRequest())
    expect(() => submitChatTurn(turnRequest())).toThrow('already running')
    const second = submitChatTurn(turnRequest({ conversationKey: 'conv-2' }))
    expect(second.turnId).toBeTruthy()

    cancelChatTurn('conv-1', second.turnId) // wrong turn: no-op
    cancelChatTurn('conv-1', first.turnId)
    cancelChatTurn('conv-2', second.turnId)
    await waitForTurnDone(first.turnId)
    await waitForTurnDone(second.turnId)
    expect(chatTurnActive('conv-1')).toBe(false)
    expect(chatTurnActive('conv-2')).toBe(false)
  })

  it('answers a Home Agent read tool from the snapshot the turn shipped', async () => {
    queueFetchMock(sse(toolCallChunks('getHomeAgentSettings', '{}')), sse(textChunks('read it')))
    submitChatTurn(
      turnRequest({
        tools: [
          { name: 'getHomeAgentSettings', description: 'Read', inputSchema: { type: 'object' } },
        ],
        homeAgentInference: homeAgentSnapshot(),
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })

    expect(sent.some((p) => p.channel === 'chat:ask')).toBe(false)
    const toolMessage = (
      requests[1].body.messages as Array<{ role: string; content: unknown }>
    ).find((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessage!.content)).toContain('qwen-9b')
    expect(chatChunks().some((c) => c.type === 'tool-input-available')).toBe(true)
    expect(chatChunks().some((c) => c.type === 'finish')).toBe(true)
    const outputChunk = chatChunks().find((c) => c.type === 'tool-output-available')
    expect(outputChunk).not.toHaveProperty('dynamic', true)
  })

  it('refuses a Home Agent settings change when the turn carries no snapshot', async () => {
    queueFetchMock(
      sse(toolCallChunks('configureHomeAgent', '{"temperature":0.9}')),
      sse(textChunks('cannot')),
    )
    submitChatTurn(
      turnRequest({
        tools: [
          { name: 'configureHomeAgent', description: 'Configure', inputSchema: { type: 'object' } },
        ],
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })

    expect(sent.some((p) => p.channel === 'chat:ask')).toBe(false)
    const toolMessage = (
      requests[1].body.messages as Array<{ role: string; content: unknown }>
    ).find((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessage!.content)).toMatch(
      /Home Agent preset is not active|only be changed/,
    )
  })

  it('diffs a settings change in main and applies it after the card is confirmed', async () => {
    queueFetchMock(
      sse(toolCallChunks('configureHomeAgent', '{"temperature":0.9}')),
      sse(textChunks('done')),
    )
    submitChatTurn(
      turnRequest({
        tools: [
          { name: 'configureHomeAgent', description: 'Configure', inputSchema: { type: 'object' } },
        ],
        homeAgentInference: homeAgentSnapshot(),
      }),
    )

    const confirm = await vi.waitFor(() => {
      const found = sent.find((p) => p.channel === 'chat:ask' && p.kind === 'home-agent-confirm')
      expect(found).toBeDefined()
      return found as { requestId: string; summaryMarkdown: string }
    })
    // The diff is main's: the card is handed a rendered summary, not the request.
    expect(confirm.summaryMarkdown).toContain('Temperature')
    expect(confirm.summaryMarkdown).toContain('0.9')
    handleChatAnswer({ requestId: confirm.requestId, result: true })

    const apply = await vi.waitFor(() => {
      const found = sent.find((p) => p.channel === 'chat:ask' && p.kind === 'home-agent-apply')
      expect(found).toBeDefined()
      return found as { requestId: string; changes: Array<{ field: string; value: unknown }> }
    })
    expect(apply.changes).toEqual([expect.objectContaining({ field: 'temperature', value: 0.9 })])
    handleChatAnswer({ requestId: apply.requestId, result: { backendChanged: false } })

    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    const toolMessage = (
      requests[1].body.messages as Array<{ role: string; content: unknown }>
    ).find((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessage!.content)).toContain('applied')
  })

  it('leaves the configuration alone when the card is declined', async () => {
    queueFetchMock(
      sse(toolCallChunks('configureHomeAgent', '{"temperature":0.9}')),
      sse(textChunks('ok then')),
    )
    submitChatTurn(
      turnRequest({
        tools: [
          { name: 'configureHomeAgent', description: 'Configure', inputSchema: { type: 'object' } },
        ],
        homeAgentInference: homeAgentSnapshot(),
      }),
    )

    const confirm = await vi.waitFor(() => {
      const found = sent.find((p) => p.channel === 'chat:ask' && p.kind === 'home-agent-confirm')
      expect(found).toBeDefined()
      return found as { requestId: string }
    })
    handleChatAnswer({ requestId: confirm.requestId, result: false })

    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:ask' && p.kind === 'home-agent-apply')).toBe(false)
    const toolMessage = (
      requests[1].body.messages as Array<{ role: string; content: unknown }>
    ).find((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessage!.content)).toContain('declined')
  })

  it('registers built-in tools as static and MCP tools as dynamic', () => {
    const tools = buildToolSet(
      [
        { name: 'media', description: 'Create media', inputSchema: { type: 'object' } },
        { name: 'mcp__files__read', description: 'Read', inputSchema: { type: 'object' } },
      ],
      'conv-1',
      undefined,
    )
    expect((tools.media as { type?: string }).type).not.toBe('dynamic')
    expect((tools['mcp__files__read'] as { type?: string }).type).toBe('dynamic')
  })

  it('fails closed when the parent media catalog is missing', async () => {
    queueFetchMock(
      sse(toolCallChunks('media', '{"request":"an image of cheese"}')),
      sse(textChunks('sorry')),
    )
    submitChatTurn(
      turnRequest({
        tools: [{ name: 'media', description: 'Create media', inputSchema: { type: 'object' } }],
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:executeTool')).toBe(false)
    expect(runMediaAgentInMainMock).not.toHaveBeenCalled()
    const errorChunk = chatChunks().find(
      (c) => c.type === 'tool-output-error' || c.type === 'error',
    )
    expect(errorChunk).toBeDefined()
    expect(JSON.stringify(errorChunk)).toMatch(/catalog|media tool is missing/i)
  })

  it('runs the parent media tool in-process and keeps condensed images on the UI stream', async () => {
    const condensed = {
      text: 'Made cheese.',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'Draft Image' },
          output: {
            images: [
              { id: 'i1', type: 'image', imageUrl: 'aipg-media://cheese.png', mode: 'imageGen' },
            ],
          },
        },
      ],
    }
    runMediaAgentInMainMock.mockResolvedValueOnce(condensed)
    queueFetchMock(
      sse(toolCallChunks('media', '{"request":"an image of cheese"}')),
      sse(textChunks('here is your cheese')),
    )
    submitChatTurn(
      turnRequest({
        tools: [{ name: 'media', description: 'Create media', inputSchema: { type: 'object' } }],
        mediaAgent: {
          system: 'You are the media specialist.',
          toolSpecs: [{ name: 'comfyUI', description: 'Create images', inputSchema: {} }],
        },
        keepModelsLoaded: true,
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:executeTool')).toBe(false)
    expect(runMediaAgentInMainMock).toHaveBeenCalledTimes(1)
    expect(runMediaAgentInMainMock.mock.calls[0][0]).toMatchObject({
      request: 'an image of cheese',
      conversationKey: 'conv-1',
      keepModelsLoaded: true,
    })
    expect(chatChunks().find((c) => c.type === 'tool-output-available')).toMatchObject({
      type: 'tool-output-available',
      output: {
        summary: 'Made cheese.',
        images: [{ id: 'i1', type: 'image', imageUrl: 'aipg-media://cheese.png' }],
      },
    })
  })

  it('waits for a slow media execute before the UI stream records the tool output', async () => {
    const condensed = {
      text: 'Made cheese.',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'Draft Image' },
          output: {
            images: [
              { id: 'i1', type: 'image', imageUrl: 'aipg-media://cheese.png', mode: 'imageGen' },
            ],
          },
        },
      ],
    }
    runMediaAgentInMainMock.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(condensed), 150)),
    )
    queueFetchMock(
      sse(toolCallChunks('media', '{"request":"an image of cheese"}')),
      sse(textChunks('here is your cheese')),
    )
    submitChatTurn(
      turnRequest({
        tools: [{ name: 'media', description: 'Create media', inputSchema: { type: 'object' } }],
        mediaAgent: {
          system: 'You are the media specialist.',
          toolSpecs: [{ name: 'comfyUI', description: 'Create images', inputSchema: {} }],
        },
        keepModelsLoaded: true,
      }),
    )
    await vi.waitFor(
      () => {
        expect(doneTurnIds().length).toBeGreaterThan(0)
      },
      { timeout: 5_000 },
    )
    expect(chatChunks().find((c) => c.type === 'tool-output-available')).toMatchObject({
      type: 'tool-output-available',
      output: {
        summary: 'Made cheese.',
        images: [{ id: 'i1', type: 'image', imageUrl: 'aipg-media://cheese.png' }],
      },
    })
  })

  it('runs parent comfyUI in-process and does not round-trip to the renderer', async () => {
    executeChatComfyToolMock.mockResolvedValueOnce({
      images: [{ id: 'i1', type: 'image', imageUrl: 'aipg-media://castle.png', mode: 'imageGen' }],
    })
    queueFetchMock(
      sse(toolCallChunks('comfyUI', '{"prompt":"a castle","workflow":"Draft Image"}')),
      sse(textChunks('here is your castle')),
    )
    submitChatTurn(
      turnRequest({
        tools: [
          {
            name: 'comfyUI',
            description: 'Generate an image',
            inputSchema: { type: 'object' },
          },
        ],
        keepModelsLoaded: true,
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:executeTool')).toBe(false)
    expect(executeChatComfyToolMock).toHaveBeenCalledTimes(1)
    expect(executeChatComfyToolMock.mock.calls[0][0]).toMatchObject({
      toolName: 'comfyUI',
      input: { prompt: 'a castle', workflow: 'Draft Image' },
      conversationKey: 'conv-1',
      keepModelsLoaded: true,
      owner: { kind: 'tool', toolCallId: expect.any(String) },
    })
    const toolCallId = (
      chatChunks().find((c) => c.type === 'tool-output-available') as {
        toolCallId?: string
      }
    )?.toolCallId
    expect(executeChatComfyToolMock.mock.calls[0][0].owner.toolCallId).toBe(toolCallId)
    expect(chatChunks().find((c) => c.type === 'tool-output-available')).toMatchObject({
      type: 'tool-output-available',
      output: {
        images: [{ id: 'i1', type: 'image', imageUrl: 'aipg-media://castle.png' }],
      },
    })
  })

  it('shows a vision model the generated image instead of the placeholder size', async () => {
    executeChatComfyToolMock.mockResolvedValueOnce({
      images: [
        {
          id: 'i1',
          type: 'image',
          imageUrl: 'aipg-media://red.png',
          mode: 'imageGen',
          settings: { preset: 'Edit by Prompt 2', width: 512, height: 512, resolution: '512x512' },
        },
      ],
    })
    queueFetchMock(
      sse(toolCallChunks('comfyUiImageEdit', '{"workflow":"Edit by Prompt 2","prompt":"red"}')),
      sse(textChunks('done')),
    )
    const { turnId } = submitChatTurn(
      turnRequest({
        tools: [{ name: 'comfyUiImageEdit', description: 'Edit', inputSchema: { type: 'object' } }],
        model: {
          backend: 'llamaCPP',
          modelId: 'test/model.gguf',
          baseUrl: 'http://127.0.0.1:39101',
          supportsVision: true,
        },
      }),
    )
    await waitForTurnDone(turnId)

    const followUp = JSON.stringify(requests[1].body.messages)
    expect(followUp).toContain('data:image/png;base64,')
    expect(followUp).toContain('attached in the following message')
    expect(followUp).not.toContain('512')
    expect(chatChunks().find((c) => c.type === 'tool-output-available')).toMatchObject({
      output: { images: [{ settings: { width: 512, height: 512 } }] },
    })
  })

  it('omits the result image when the model does not support vision', async () => {
    executeChatComfyToolMock.mockResolvedValueOnce({
      images: [
        {
          id: 'i1',
          type: 'image',
          imageUrl: 'aipg-media://red.png',
          mode: 'imageGen',
          settings: { preset: 'Edit by Prompt 2', width: 512, height: 512, resolution: '512x512' },
        },
      ],
    })
    queueFetchMock(
      sse(toolCallChunks('comfyUiImageEdit', '{"workflow":"Edit by Prompt 2","prompt":"red"}')),
      sse(textChunks('done')),
    )
    const { turnId } = submitChatTurn(
      turnRequest({
        tools: [{ name: 'comfyUiImageEdit', description: 'Edit', inputSchema: { type: 'object' } }],
        model: {
          backend: 'llamaCPP',
          modelId: 'test/model.gguf',
          baseUrl: 'http://127.0.0.1:39101',
          supportsVision: false,
        },
      }),
    )
    await waitForTurnDone(turnId)

    const followUp = JSON.stringify(requests[1].body.messages)
    expect(followUp).toContain('aipg-media://red.png')
    expect(followUp).toContain('Image generated with Edit by Prompt 2.')
    expect(followUp).not.toContain('512')
    expect(followUp).not.toContain('image_url')
    expect(followUp).not.toContain('data:image')
    expect(readMediaAsDataUri).not.toHaveBeenCalled()
  })

  it('repairs an invalid comfyUI workflow before executing in-process', async () => {
    queueFetchMock(
      sse(toolCallChunks('comfyUI', '{"prompt":"a castle","workflow":"nope"}')),
      sse(textChunks('made it')),
    )
    submitChatTurn(
      turnRequest({
        tools: [
          {
            name: 'comfyUI',
            description: 'Generate an image',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                workflow: { type: 'string', enum: ['Draft Image'] },
              },
              required: ['prompt', 'workflow'],
            },
          },
        ],
        repairData: { comfyUI: { names: ['Draft Image'], defaultWorkflow: 'Draft Image' } },
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:executeTool')).toBe(false)
    expect(executeChatComfyToolMock).toHaveBeenCalledTimes(1)
    expect(executeChatComfyToolMock.mock.calls[0][0]).toMatchObject({
      toolName: 'comfyUI',
      input: { prompt: 'a castle', workflow: 'Draft Image' },
      defaultWorkflow: 'Draft Image',
    })
  })

  it('invokes an MCP tool in main and flattens no name parsing to the renderer', async () => {
    vi.mocked(listMcpServers).mockReturnValue([
      { id: 'files', name: 'Files' },
    ] as unknown as ReturnType<typeof listMcpServers>)
    vi.mocked(invokeMcpServerTool).mockResolvedValueOnce({
      isError: false,
      structuredContent: { text: 'hello' },
    } as unknown as Awaited<ReturnType<typeof invokeMcpServerTool>>)
    queueFetchMock(
      sse(toolCallChunks('mcp__files__read_file', '{"path":"a.txt"}')),
      sse(textChunks('read it')),
    )
    submitChatTurn(
      turnRequest({
        tools: [
          { name: 'mcp__files__read_file', description: 'Read', inputSchema: { type: 'object' } },
        ],
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:executeTool')).toBe(false)
    expect(invokeMcpServerTool).toHaveBeenCalledWith('files', 'read_file', { path: 'a.txt' })
  })

  it('drives the web browser in main and sends the model the formatted page', async () => {
    webBrowserMock.navigate.mockResolvedValueOnce({
      title: 'Example',
      url: 'https://example.com/',
      text: 'Hello world',
      links: [{ index: 0, text: 'More', href: 'https://example.com/more' }],
    })
    queueFetchMock(
      sse(toolCallChunks('browseWeb', '{"url":"example.com"}')),
      sse(textChunks('read the page')),
    )
    submitChatTurn(
      turnRequest({
        tools: [{ name: 'browseWeb', description: 'Open a page', inputSchema: { type: 'object' } }],
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:executeTool')).toBe(false)
    expect(webBrowserMock.navigate).toHaveBeenCalledWith('example.com')
    const toolMessage = (
      requests[1].body.messages as Array<{ role: string; content: unknown }>
    ).find((m) => m.role === 'tool')
    // The formatters moved to main with the bodies: the model gets the flat
    // page text, not the JSON snapshot the UI keeps.
    expect(JSON.stringify(toolMessage!.content)).toContain('Title: Example')
    expect(JSON.stringify(toolMessage!.content)).toContain('[0] More')
  })

  it('captures the window the turn shipped and keeps the base64 out of the tool message', async () => {
    captureWindowMock.mockResolvedValueOnce('data:image/png;base64,AAAA')
    queueFetchMock(sse(toolCallChunks('captureScreenshot', '{}')), sse(textChunks('looked')))
    submitChatTurn(
      turnRequest({
        tools: [
          { name: 'captureScreenshot', description: 'Capture', inputSchema: { type: 'object' } },
        ],
        screenshotWindow: { id: 'window:7', name: 'Notepad' },
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:executeTool')).toBe(false)
    expect(captureWindowMock).toHaveBeenCalledWith({ id: 'window:7', name: 'Notepad' })
    const toolMessage = (
      requests[1].body.messages as Array<{ role: string; content: unknown }>
    ).find((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessage!.content)).toContain('Notepad')
    expect(JSON.stringify(toolMessage!.content)).not.toContain('AAAA')
  })

  it('reports the missing-window case without capturing', async () => {
    queueFetchMock(sse(toolCallChunks('captureScreenshot', '{}')), sse(textChunks('cannot')))
    submitChatTurn(
      turnRequest({
        tools: [
          { name: 'captureScreenshot', description: 'Capture', inputSchema: { type: 'object' } },
        ],
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(captureWindowMock).not.toHaveBeenCalled()
    const toolMessage = (
      requests[1].body.messages as Array<{ role: string; content: unknown }>
    ).find((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessage!.content)).toMatch(/No window is selected/)
  })

  it('runs speech synthesis in main and tells the model where the clip landed', async () => {
    executeChatSpeechToolMock.mockResolvedValueOnce({
      ok: true,
      message: 'Synthesized speech with Kokoro (af_heart).',
      savedFilePath: '/audio/trip_planning.wav',
      speaker: 'af_heart',
    })
    queueFetchMock(
      sse(toolCallChunks('synthesizeTextToSpeech', '{"text":"hello there"}')),
      sse(textChunks('spoken')),
    )
    submitChatTurn(
      turnRequest({
        tools: [
          { name: 'synthesizeTextToSpeech', description: 'Speak', inputSchema: { type: 'object' } },
        ],
        conversationLabel: 'Trip planning',
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:executeTool')).toBe(false)
    expect(executeChatSpeechToolMock.mock.calls[0][0]).toMatchObject({
      toolName: 'synthesizeTextToSpeech',
      input: { text: 'hello there' },
      conversationKey: 'conv-1',
      conversationLabel: 'Trip planning',
    })
    const toolMessage = (
      requests[1].body.messages as Array<{ role: string; content: unknown }>
    ).find((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessage!.content)).toContain('/audio/trip_planning.wav')
  })

  it('transcribes in main, handing the tool the turn messages', async () => {
    executeChatSpeechToolMock.mockResolvedValueOnce({
      ok: true,
      message: 'Transcribed audio.',
      transcript: 'the recorded words',
    })
    queueFetchMock(sse(toolCallChunks('transcribeAudio', '{}')), sse(textChunks('read back')))
    submitChatTurn(
      turnRequest({
        tools: [
          { name: 'transcribeAudio', description: 'Transcribe', inputSchema: { type: 'object' } },
        ],
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:executeTool')).toBe(false)
    expect(executeChatSpeechToolMock.mock.calls[0][0]).toMatchObject({
      toolName: 'transcribeAudio',
    })
    expect(executeChatSpeechToolMock.mock.calls[0][0].messages).toBeDefined()
    const toolMessage = (
      requests[1].body.messages as Array<{ role: string; content: unknown }>
    ).find((m) => m.role === 'tool')
    // The transcript itself is what the model reads, not the wrapper object.
    expect(JSON.stringify(toolMessage!.content)).toContain('the recorded words')
  })

  it('fails closed on a tool name main does not execute', async () => {
    queueFetchMock(sse(toolCallChunks('inventedTool', '{}')), sse(textChunks('sorry')))
    submitChatTurn(
      turnRequest({
        tools: [{ name: 'inventedTool', description: 'Nope', inputSchema: { type: 'object' } }],
      }),
    )
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
    expect(sent.some((p) => p.channel === 'chat:executeTool')).toBe(false)
    const errorChunk = chatChunks().find(
      (c) => c.type === 'tool-output-error' || c.type === 'error',
    )
    expect(JSON.stringify(errorChunk)).toMatch(/cannot round-trip to the renderer/)
  })

  it('strips image parts for non-vision models and keeps text', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(
      turnRequest({
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [
              { type: 'text', text: 'describe' },
              { type: 'file', mediaType: 'image/png', url: 'aipg-media://a.png' },
            ],
          },
        ],
        model: {
          backend: 'llamaCPP',
          modelId: 'test/model.gguf',
          baseUrl: 'http://127.0.0.1:39101',
          supportsVision: false,
        },
      }),
    )
    await waitForTurnDone(turnId)

    const userMessage = bodyMessages().find((m) => m.role === 'user')
    expect(JSON.stringify(userMessage!.content)).not.toContain('image_url')
    expect(JSON.stringify(userMessage!.content)).toContain('describe')
  })

  it('describes an attached clip to the model and hands the tool the real one', async () => {
    executeChatSpeechToolMock.mockResolvedValueOnce({
      ok: true,
      message: 'Transcribed audio.',
      transcript: 'the recorded words',
    })
    queueFetchMock(sse(toolCallChunks('transcribeAudio', '{}')), sse(textChunks('read back')))
    const { turnId } = submitChatTurn(
      turnRequest({
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [
              { type: 'text', text: 'what does this say' },
              {
                type: 'file',
                mediaType: 'audio/wav',
                url: 'aipg-media://media/input/clip.wav',
                filename: 'clip.wav',
              },
            ],
          },
        ],
        tools: [
          { name: 'transcribeAudio', description: 'Transcribe', inputSchema: { type: 'object' } },
        ],
        model: {
          backend: 'llamaCPP',
          modelId: 'test/model.gguf',
          baseUrl: 'http://127.0.0.1:39101',
          supportsVision: true,
        },
      }),
    )
    await waitForTurnDone(turnId)

    // llama.cpp rejects the whole request over an audio part, so the model is
    // told about the clip rather than sent it.
    const sentUser = JSON.stringify(bodyMessages().find((m) => m.role === 'user')!.content)
    expect(sentUser).toContain('clip.wav')
    expect(sentUser).toContain('transcribeAudio')
    expect(sentUser).not.toContain('input_audio')
    expect(sentUser).not.toContain('aipg-media://media/input/clip.wav')

    const toolMessages = executeChatSpeechToolMock.mock.calls[0][0].messages as Array<{
      role: string
      content: unknown
    }>
    expect(JSON.stringify(toolMessages)).toContain('aipg-media://media/input/clip.wav')
  })

  it('converts aipg-media references to data URIs for vision models', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(
      turnRequest({
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [
              { type: 'file', mediaType: 'image/png', url: 'aipg-media://a.png' },
              { type: 'text', text: 'see this' },
            ],
          },
        ],
        model: {
          backend: 'llamaCPP',
          modelId: 'test/model.gguf',
          baseUrl: 'http://127.0.0.1:39101',
          supportsVision: true,
        },
      }),
    )
    await waitForTurnDone(turnId)

    expect(readMediaAsDataUri).toHaveBeenCalledWith('aipg-media://a.png')
    const userMessage = bodyMessages().find((m) => m.role === 'user')
    expect(JSON.stringify(userMessage!.content)).toContain('data:image/png;base64,')
  })

  it('replaces screenshot tool results with a vision image follow-up message', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(
      turnRequest({
        messages: [
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'look' }] },
          {
            id: 'm2',
            role: 'assistant',
            parts: [
              {
                type: 'tool-captureScreenshot',
                toolCallId: 'c1',
                state: 'output-available',
                input: {},
                output: { ok: true, windowName: 'w', dataUri: 'data:image/png;base64,AAA' },
              },
            ],
          },
          { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'what do you see' }] },
        ],
        tools: [
          { name: 'captureScreenshot', description: 'Capture', inputSchema: { type: 'object' } },
        ],
        model: {
          backend: 'llamaCPP',
          modelId: 'test/model.gguf',
          baseUrl: 'http://127.0.0.1:39101',
          supportsVision: true,
        },
      }),
    )
    await waitForTurnDone(turnId)

    const serialized = JSON.stringify(bodyMessages())
    expect(serialized).toContain('captured. The image is attached in the following message.')
    expect(serialized).toContain('data:image/png;base64,AAA')
    const injected = bodyMessages().find(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('captured screenshot'),
    )
    expect(injected).toBeDefined()
  })

  it('slims replayed media tool results before they reach the model', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(
      turnRequest({
        messages: [
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'make art' }] },
          {
            id: 'm2',
            role: 'assistant',
            parts: [
              {
                type: 'tool-media',
                toolCallId: 'c1',
                state: 'output-available',
                input: { request: 'art' },
                output: {
                  images: [
                    {
                      id: 'i1',
                      type: 'image',
                      imageUrl: 'aipg-media://img.png',
                      mode: 'image',
                      settings: { big: 'x'.repeat(200) },
                    },
                  ],
                  steps: ['did'],
                  summary: 'art made',
                },
              },
            ],
          },
          { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'nice' }] },
        ],
        tools: [{ name: 'media', description: 'Create media', inputSchema: { type: 'object' } }],
      }),
    )
    await waitForTurnDone(turnId)

    const toolMessage = bodyMessages().find((m) => m.role === 'tool')
    const serialized = JSON.stringify(toolMessage!.content)
    expect(serialized).toContain('art made')
    expect(serialized).toContain('i1')
    expect(serialized).not.toContain('settings')
    expect(serialized).not.toContain('big')
  })

  it('appends running MCP server instructions when asked', async () => {
    vi.mocked(listMcpServers).mockReturnValue([
      { id: 's1', name: 'Serv', instructions: 'Do things' },
      { id: 's2', name: 'Off', instructions: 'Should not appear' },
    ] as never)
    vi.mocked(getMcpServerStatus).mockImplementation(
      (id: string) => ({ state: id === 's1' ? 'running' : 'stopped' }) as never,
    )
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(turnRequest({ includeMcpInstructions: true }))
    await waitForTurnDone(turnId)

    const system = bodyMessages().find((m) => m.role === 'system')
    const content = String(system!.content)
    expect(content).toContain('You are helpful.')
    expect(content).toContain('# MCP server instructions')
    expect(content).toContain('## MCP server: Serv')
    expect(content).toContain('Do things')
    expect(content).not.toContain('Off')
  })

  it('surfaces a backend error as an error chunk, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 400, statusText: 'Bad Request' })),
    )
    const { turnId } = submitChatTurn(turnRequest())
    await waitForTurnDone(turnId)

    const error = chatChunks().find((c) => c.type === 'error') as { errorText?: string } | undefined
    expect(error).toBeDefined()
    expect(error!.errorText).toContain('HTTP 400')
    expect(error!.errorText).toContain('boom')
    expect(chatTurnActive('conv-1')).toBe(false)
  })

  it('cancels a turn without surfacing an error chunk', async () => {
    queueFetchMock(pending())
    const { turnId } = submitChatTurn(turnRequest())
    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThan(0)
    })
    cancelChatTurn('conv-1', turnId)
    await waitForTurnDone(turnId)

    expect(chatChunks().some((c) => c.type === 'error')).toBe(false)
    expect(chatTurnActive('conv-1')).toBe(false)
  })

  it('resumeChatTurn includes the live turnId so a reloaded renderer can reconnect', async () => {
    queueFetchMock(pending())
    const { turnId } = submitChatTurn(turnRequest())
    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThan(0)
    })
    const resumed = resumeChatTurn('conv-1')
    expect(resumed).toMatchObject({
      turnId,
      chunks: expect.any(Array),
      sequence: expect.any(Number),
    })
    expect(resumeChatTurn('conv-missing')).toBeNull()
    cancelChatTurn('conv-1', turnId)
    await waitForTurnDone(turnId)
  })

  it('retrieves RAG after GPU admit, then streams with the augmented prompt', async () => {
    const ensureBackendReadiness = vi.fn(async () => {})
    const awaitChatWindow = vi.fn(async () => {})
    setChatReadinessDeps({
      getService: () => ({ ensureBackendReadiness, baseUrl: 'http://127.0.0.1:39101' }),
      awaitChatWindow,
      stopOvmsImageServer: vi.fn(async () => {}),
      notifyHomeAgentUpstreamReady: vi.fn(),
    })
    const prepareRag = vi.fn(async (_rag, base: string) => ({
      systemPrompt: `${base}\n\nUse the following context from your knowledge base to answer the question:\n\nchunk`,
      sourceText: 'doc.txt (Lines 1-2)',
    }))
    setChatEngineDeps({ readMediaAsDataUri, prepareRag })
    queueFetchMock(sse(textChunks('ok')))
    const base = turnRequest()
    const { turnId } = submitChatTurn({
      ...base,
      rag: {
        query: 'hi',
        documentHashes: ['abc'],
        useGroupRetrieval: false,
        embeddingServiceName: 'llamacpp-backend',
        embeddingModel: 'bge',
        maxResults: 8,
        perDocResults: 5,
      },
      model: {
        ...base.model,
        readiness: {
          serviceName: 'llamacpp-backend',
          llmModelName: 'test/model.gguf',
        },
      },
    })
    await waitForTurnDone(turnId)

    expect(awaitChatWindow).not.toHaveBeenCalled()
    expect(prepareRag).toHaveBeenCalledTimes(1)
    const textStarted = textQueueEvents().findIndex((e) => e.action === 'started')
    const ragIdx = events.findIndex((e) => e.type === 'chat-rag')
    expect(textStarted).toBeGreaterThanOrEqual(0)
    expect(ragIdx).toBeGreaterThan(textStarted)
    expect(bodyMessages()[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('Use the following context'),
    })
    const ragEvents = events.filter((e) => e.type === 'chat-rag')
    expect(ragEvents).toHaveLength(1)
    expect(ragEvents[0]).toMatchObject({
      conversationKey: 'conv-1',
      turnId,
      sourceText: 'doc.txt (Lines 1-2)',
    })
  })

  it('does not emit chat-rag when the request has no rag field', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(turnRequest())
    await waitForTurnDone(turnId)
    expect(events.filter((e) => e.type === 'chat-rag')).toEqual([])
    expect(bodyMessages()[0]).toMatchObject({ role: 'system', content: 'You are helpful.' })
  })

  it('writes the thread file on turn start and again with the assembled assistant', async () => {
    queueFetchMock(sse(textChunks('Hello')))
    const persist = {
      meta: { presetName: 'Qwen', kind: 'main' as const },
      ragHashes: ['doc-a'],
      lastMainKey: 'conv-1',
    }
    const { turnId } = submitChatTurn(turnRequest({ persist }))
    await waitForTurnDone(turnId)

    expect(saveChatTurnConversation).toHaveBeenCalledTimes(2)
    expect(saveChatTurnConversation.mock.calls[0]?.[0]).toMatchObject({
      id: 'conv-1',
      meta: persist.meta,
      ragHashes: ['doc-a'],
      lastMainKey: 'conv-1',
      messages: [{ id: 'm1', role: 'user' }],
    })
    const endMessages = (
      saveChatTurnConversation.mock.calls[1]?.[0] as unknown as {
        messages: Array<{ role: string; metadata?: { ragSource?: string } }>
      }
    ).messages
    expect(endMessages[0]).toMatchObject({ role: 'user' })
    expect(endMessages.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('stamps ragSource onto the persisted assistant when retrieval ran', async () => {
    const prepareRag = vi.fn(async () => ({
      systemPrompt: 'augmented',
      sourceText: 'doc.txt (Lines 1-2)',
    }))
    setChatEngineDeps({ readMediaAsDataUri, prepareRag })
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(
      turnRequest({
        persist: { meta: null, ragHashes: ['h'] },
        rag: {
          query: 'hi',
          documentHashes: ['h'],
          useGroupRetrieval: false,
          embeddingServiceName: 'llamacpp-backend',
          embeddingModel: 'embed',
          maxResults: 4,
          perDocResults: 2,
        },
      }),
    )
    await waitForTurnDone(turnId)

    const endMessages = (
      saveChatTurnConversation.mock.calls[1]?.[0] as unknown as {
        messages: Array<{ role: string; metadata?: { ragSource?: string } }>
      }
    ).messages
    const assistant = endMessages.find((m) => m.role === 'assistant')
    expect(assistant?.metadata?.ragSource).toBe('doc.txt (Lines 1-2)')
  })

  it('does not write a conversation file when persist is omitted', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(turnRequest())
    await waitForTurnDone(turnId)
    expect(saveChatTurnConversation).not.toHaveBeenCalled()
  })
})
