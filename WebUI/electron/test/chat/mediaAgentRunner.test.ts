import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { KernelEvent } from '@/types/kernelEvents'
import type { ChatToolSpec, MediaAgentRunRequest } from '@/types/chatIpc'

// Main-side media specialist runner (step 12): the nested tool loop runs in
// main, inner Comfy tools execute in-process against the Artifact runner.
// Driven here with a scripted mock model; assertions cover the wiring — the
// in-process payload (source image, origin, keepModelsLoaded), shipped repair
// data coercing a bogus workflow, progress on the kernel stream, and cancel
// aborting the in-process run.

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../chat/chatModelMain', () => ({
  createMainChatModel: vi.fn(),
}))

vi.mock('../../adapters/mcp/mcpManager', () => ({
  listMcpServers: vi.fn(),
  getMcpServerStatus: vi.fn(),
}))

vi.mock('../../observability/laminar', () => ({
  noteLlamaCppChatTimings: vi.fn(),
  noteMainChatTurnContext: vi.fn(),
  markDelegatedMediaRun: vi.fn(),
}))

vi.mock('../../kernel/orchestrator', () => ({
  runMediaRequest: async <T>(fn: () => Promise<T>) => fn(),
}))

const runInProcessComfyToolMock = vi.fn()
vi.mock('../../artifact/inProcessComfy', () => ({
  runInProcessComfyTool: (...args: unknown[]) => runInProcessComfyToolMock(...args),
}))

const { runMediaAgentInMain, cancelMediaAgentRun } = await import('../../chat/mediaAgentRunner')
const { createMainChatModel } = await import('../../chat/chatModelMain')
const { setKernelEventWindow, resetKernelBusForTest, onKernelEvent } =
  await import('../../kernel/kernelBus')

type SentPayload = Record<string, unknown>

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

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

function stream(...parts: Record<string, unknown>[]) {
  return {
    stream: simulateReadableStream({
      chunks: [{ type: 'stream-start', warnings: [] }, ...parts] as never[],
      chunkDelayInMs: 0,
    }),
  }
}

function toolCallResponse(toolName: string, input: Record<string, unknown>, id: string) {
  return stream(
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
  )
}

function textResponse(text: string) {
  return stream(
    { type: 'text-start', id: 't0' },
    { type: 'text-delta', id: 't0', delta: text },
    { type: 'text-end', id: 't0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
  )
}

const TOOL_SPEC: ChatToolSpec = {
  name: 'comfyUI',
  description: 'Create images',
  inputSchema: { type: 'object', properties: { workflow: { type: 'string' } } },
}

function runRequest(overrides: Partial<MediaAgentRunRequest> = {}): MediaAgentRunRequest {
  return {
    runKey: 'media-run:test',
    request: 'a castle image',
    sourceImage: 'data:image/png;base64,aGk=',
    system: 'You are the media specialist.',
    toolSpecs: [TOOL_SPEC],
    repairData: { comfyUI: { names: ['W1'], defaultWorkflow: 'W1' } },
    model: {
      backend: 'llamaCPP',
      modelId: 'test-model',
      baseUrl: 'http://127.0.0.1:39101',
    },
    ...overrides,
  }
}

let events: KernelEvent[]
let detachTap: () => void

beforeEach(() => {
  vi.clearAllMocks()
  resetKernelBusForTest()
  events = []
  detachTap = onKernelEvent((event) => void events.push(event))
  const window = fakeWindow()
  setKernelEventWindow(window.win)
  runInProcessComfyToolMock.mockResolvedValue({
    images: [
      {
        id: 'i1',
        type: 'image',
        imageUrl: 'aipg-media://castle.png',
        mode: 'imageGen',
        settings: { preset: 'W1', bulky: 'x'.repeat(40) },
      },
    ],
  })
})

afterEach(() => {
  detachTap()
  vi.unstubAllGlobals()
})

function mediaEvents() {
  return events
    .filter(
      (e): e is Extract<KernelEvent, { type: 'media-agent-event' }> =>
        e.type === 'media-agent-event',
    )
    .map((e) => e.event)
}

describe('runMediaAgentInMain', () => {
  it('runs the nested loop with in-process Comfy and the nested history', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('comfyUI', { workflow: 'W1' }, 'c1')
        return textResponse('Made the castle.')
      },
    })
    vi.mocked(createMainChatModel).mockReturnValue(model)

    const result = await runMediaAgentInMain(runRequest())

    expect(runInProcessComfyToolMock).toHaveBeenCalledTimes(1)
    expect(runInProcessComfyToolMock.mock.calls[0][0]).toMatchObject({
      kind: 'create',
      args: { workflow: 'W1' },
      origin: 'agent',
      keepModelsLoaded: false,
      // The inner call owns the run; the delegating media call collects it.
      owner: { kind: 'tool', toolCallId: 'c1', parentToolCallId: runRequest().runKey },
    })

    expect(result.text).toBe('Made the castle.')
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].output).toMatchObject({
      images: [{ id: 'i1', type: 'image', imageUrl: 'aipg-media://castle.png' }],
    })
    expect(JSON.stringify(result.steps[0].output)).not.toContain('bulky')

    const progress = mediaEvents()
    expect(progress.filter((e) => e.type === 'phase')).toEqual([
      { type: 'phase', phase: 'planning' },
      { type: 'phase', phase: 'running-tool' },
      { type: 'phase', phase: 'planning' },
    ])
    expect(progress.filter((e) => e.type === 'tool-start')).toHaveLength(1)
    expect(progress.filter((e) => e.type === 'tool-finish')).toHaveLength(1)
    expect(
      progress.some((e) => e.type === 'narration-delta' && e.text === 'Made the castle.'),
    ).toBe(true)
  })

  it('tags renderer-origin runs with the parent conversation key', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('comfyUI', { workflow: 'W1' }, 'c1')
        return textResponse('Done.')
      },
    })
    vi.mocked(createMainChatModel).mockReturnValue(model)

    await runMediaAgentInMain(runRequest({ conversationKey: 'conv-1', keepModelsLoaded: true }))

    expect(runInProcessComfyToolMock.mock.calls[0][0]).toMatchObject({
      origin: 'renderer',
      conversationKey: 'conv-1',
      keepModelsLoaded: true,
    })
  })

  it('coerces a bogus workflow to the default via the shipped repair data', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('comfyUI', { workflow: 'bogus' }, 'c1')
        return textResponse('Done.')
      },
    })
    vi.mocked(createMainChatModel).mockReturnValue(model)

    await runMediaAgentInMain(runRequest())

    expect(runInProcessComfyToolMock.mock.calls[0][0]).toMatchObject({
      args: { workflow: 'W1' },
    })
  })

  it('cancel aborts a pending in-process run and the specialist settles as a failure', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('comfyUI', { workflow: 'W1' }, 'c1')
        return textResponse('Stopped.')
      },
    })
    vi.mocked(createMainChatModel).mockReturnValue(model)

    runInProcessComfyToolMock.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const fail = () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }
          if (signal?.aborted) {
            fail()
            return
          }
          signal?.addEventListener('abort', fail, { once: true })
        }),
    )

    const run = runMediaAgentInMain(runRequest())
    await vi.waitFor(() => {
      if (runInProcessComfyToolMock.mock.calls.length === 0) {
        throw new Error('in-process run not started yet')
      }
    })
    cancelMediaAgentRun('media-run:test')

    await expect(run).rejects.toThrow()
    expect(() => cancelMediaAgentRun('media-run:unknown')).not.toThrow()
  })
})
