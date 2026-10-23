import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../observability/laminarAttributes.ts', () => ({
  recordAgentCallStats: vi.fn(),
}))

const {
  observeAgentModelCalls,
  piAgentCallsActive,
  resetAgentModelCallTrackingForTest,
  trackAgentModelCalls,
} = await import('../../agent/piCallTiming')

const LOCAL = 'http://127.0.0.1:39100'
const CLOUD = 'http://127.0.0.1:41000/v1'

function hangingResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {})
      },
    }),
    { status: 200 },
  )
}

function doneResponse(body = 'ok'): Response {
  return new Response(body, { status: 200 })
}

describe('piCallTiming occupancy', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetAgentModelCallTrackingForTest()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    resetAgentModelCallTrackingForTest()
    vi.unstubAllGlobals()
  })

  it('counts a local call until its body is drained', async () => {
    fetchMock.mockResolvedValue(hangingResponse())
    trackAgentModelCalls(() => LOCAL)

    const pending = globalThis.fetch(`${LOCAL}/v1/chat/completions`)
    await vi.waitFor(() => expect(piAgentCallsActive()).toBe(1))

    const response = await pending
    expect(piAgentCallsActive()).toBe(1)
    await response.body?.cancel()
    expect(piAgentCallsActive()).toBe(0)
  })

  it('releases occupancy when a finished local body is read', async () => {
    fetchMock.mockResolvedValue(doneResponse('ok'))
    trackAgentModelCalls(() => LOCAL)
    const response = await globalThis.fetch(`${LOCAL}/v1/chat/completions`)
    expect(piAgentCallsActive()).toBe(1)
    expect(await response.text()).toBe('ok')
    expect(piAgentCallsActive()).toBe(0)
  })

  it('does not count a URL outside the local endpoint', async () => {
    fetchMock.mockResolvedValue(doneResponse())
    trackAgentModelCalls(() => LOCAL)
    await globalThis.fetch(`${CLOUD}/chat/completions`)
    expect(piAgentCallsActive()).toBe(0)
  })

  it('does not count cloud tracing calls toward occupancy', async () => {
    fetchMock.mockResolvedValue(hangingResponse())
    observeAgentModelCalls(() => CLOUD)
    const pending = globalThis.fetch(`${CLOUD}/chat/completions`)
    await pending
    expect(piAgentCallsActive()).toBe(0)
  })

  it('releases occupancy when the local fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    trackAgentModelCalls(() => LOCAL)
    await expect(globalThis.fetch(`${LOCAL}/v1/chat/completions`)).rejects.toThrow('ECONNRESET')
    expect(piAgentCallsActive()).toBe(0)
  })

  it('tracks overlapping local calls', async () => {
    fetchMock.mockImplementation(async () => hangingResponse())
    trackAgentModelCalls(() => LOCAL)
    const first = globalThis.fetch(`${LOCAL}/a`)
    const second = globalThis.fetch(`${LOCAL}/b`)
    await vi.waitFor(() => expect(piAgentCallsActive()).toBe(2))
    await (await first).body?.cancel()
    expect(piAgentCallsActive()).toBe(1)
    await (await second).body?.cancel()
    expect(piAgentCallsActive()).toBe(0)
  })
})
