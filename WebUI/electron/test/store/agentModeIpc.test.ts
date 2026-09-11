import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const onStreamChunk = vi.fn(() => vi.fn())
const onToolProgress = vi.fn(() => vi.fn())
const onToolImage = vi.fn(() => vi.fn())
const onTurnDone = vi.fn(() => vi.fn())
const onExecuteTool = vi.fn(() => vi.fn())

const handlers = {
  onStreamChunk: vi.fn(),
  onToolProgress: vi.fn(),
  onToolImage: vi.fn(),
  onTurnDone: vi.fn(),
  onExecuteTool: vi.fn(),
}

describe('registerAgentModeIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window = {
      electronAPI: {
        agentMode: { onStreamChunk, onToolProgress, onToolImage, onTurnDone, onExecuteTool },
      },
    } as unknown as Window & typeof globalThis
  })

  afterEach(async () => {
    const { unregisterAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
    unregisterAgentModeIpc()
  })

  it('subscribes each push channel once', async () => {
    const { registerAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
    registerAgentModeIpc(handlers)
    registerAgentModeIpc(handlers)
    expect(onStreamChunk).toHaveBeenCalledTimes(1)
    expect(onToolProgress).toHaveBeenCalledTimes(1)
    expect(onToolImage).toHaveBeenCalledTimes(1)
    expect(onTurnDone).toHaveBeenCalledTimes(1)
    expect(onExecuteTool).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes so the next register attaches fresh listeners', async () => {
    const { registerAgentModeIpc, unregisterAgentModeIpc } =
      await import('@/assets/js/store/agentModeIpc')
    const disposeStream = vi.fn()
    onStreamChunk.mockReturnValueOnce(disposeStream)
    registerAgentModeIpc(handlers)
    unregisterAgentModeIpc()
    expect(disposeStream).toHaveBeenCalledTimes(1)
    registerAgentModeIpc(handlers)
    expect(onStreamChunk).toHaveBeenCalledTimes(2)
  })
})
