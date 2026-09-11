import { describe, it, expect, vi, beforeEach } from 'vitest'

// The bridge talks to the media specialist, the ComfyUI tools and the model
// selection; none of that is under test here, only the order calls run in.
const runMediaAgent = vi.fn()
const executeComfyGeneration = vi.fn()

vi.mock('@/assets/js/agents/mediaAgent', () => ({
  mediaAgentHasTools: () => true,
  runMediaAgent: (options: unknown) => runMediaAgent(options),
}))
vi.mock('@/assets/js/tools/comfyUi', () => ({
  comfyUI: { description: '', inputSchema: {} },
  executeComfyGeneration: (...args: unknown[]) => executeComfyGeneration(...args),
}))
vi.mock('@/assets/js/tools/comfyUiImageEdit', () => ({
  comfyUiImageEdit: { description: '', inputSchema: {} },
  executeImageEdit: vi.fn(),
}))
vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({ toolDelegationEnabled: true }),
}))
vi.mock('@/lib/chatModel', () => ({ createChatModel: () => ({}) }))

import { executeAgentTool } from '@/assets/js/tools/agentBridge'

const mediaResult = { summary: 'done', steps: [], success: true, message: '', images: [] }

/** A promise plus the handles to settle it from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function media(toolCallId: string, abortSignal?: AbortSignal) {
  return executeAgentTool('media', { request: toolCallId }, toolCallId, abortSignal)
}

describe('executeAgentTool queueing', () => {
  beforeEach(() => {
    runMediaAgent.mockReset()
    executeComfyGeneration.mockReset()
  })

  it('runs concurrently dispatched media calls one after another', async () => {
    // Every tool here drives the same ComfyUI server and the same generation
    // store, so overlapping runs corrupt each other's progress and items.
    const first = deferred<typeof mediaResult>()
    const second = deferred<typeof mediaResult>()
    runMediaAgent
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const calls = [media('a'), media('b')]
    await vi.waitFor(() => expect(runMediaAgent).toHaveBeenCalledTimes(1))

    // Still one, however long the second call waits: the pipeline is busy.
    await Promise.resolve()
    expect(runMediaAgent).toHaveBeenCalledTimes(1)
    expect(runMediaAgent.mock.calls[0][0]).toMatchObject({ runId: 'a' })

    first.resolve(mediaResult)
    await vi.waitFor(() => expect(runMediaAgent).toHaveBeenCalledTimes(2))
    expect(runMediaAgent.mock.calls[1][0]).toMatchObject({ runId: 'b' })

    second.resolve(mediaResult)
    await expect(Promise.all(calls)).resolves.toHaveLength(2)
  })

  it('lets the next call through when one fails', async () => {
    runMediaAgent
      .mockRejectedValueOnce(new Error('ComfyUI is not running'))
      .mockResolvedValueOnce(mediaResult)

    const failing = media('a')
    const next = media('b')

    await expect(failing).rejects.toThrow('ComfyUI is not running')
    await expect(next).resolves.toMatchObject({ summary: 'done' })
  })

  it('never starts a call that was cancelled while it waited', async () => {
    const first = deferred<typeof mediaResult>()
    runMediaAgent.mockImplementationOnce(() => first.promise)

    const running = media('a')
    const abort = new AbortController()
    const waiting = media('b', abort.signal)
    abort.abort()

    first.resolve(mediaResult)
    await expect(running).resolves.toMatchObject({ summary: 'done' })
    await expect(waiting).rejects.toThrow(/Cancelled while waiting for the media pipeline/)
    expect(runMediaAgent).toHaveBeenCalledTimes(1)
  })

  it('queues the undelegated image tools on the same pipeline', async () => {
    const first = deferred<{ images: never[] }>()
    executeComfyGeneration
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ images: [] })

    const calls = [
      executeAgentTool('generateImage', { prompt: 'a' }, 'a'),
      executeAgentTool('generateImage', { prompt: 'b' }, 'b'),
    ]
    await vi.waitFor(() => expect(executeComfyGeneration).toHaveBeenCalledTimes(1))
    expect(executeComfyGeneration).toHaveBeenCalledTimes(1)

    first.resolve({ images: [] })
    await Promise.all(calls)
    expect(executeComfyGeneration).toHaveBeenCalledTimes(2)
  })
})
