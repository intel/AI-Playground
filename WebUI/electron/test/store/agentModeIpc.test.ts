import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

const onKernelEvent = vi.fn((_listener: (event: KernelEvent) => void) => vi.fn())
const getKernelSnapshot = vi.fn()
const onExecuteTool = vi.fn(() => vi.fn())

const handlers = {
  onStreamChunk: vi.fn(),
  onToolProgress: vi.fn(),
  onToolImage: vi.fn(),
  onTurnDone: vi.fn(),
  onExecuteTool: vi.fn(),
  onSnapshot: vi.fn(),
}

const serviceEvent: KernelEvent = {
  type: 'service',
  info: { serviceName: 'ai-backend', status: 'running' },
  scope: { kind: 'global' },
  seq: 1,
}

describe('registerAgentModeIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onKernelEvent.mockImplementation(() => vi.fn())
    onExecuteTool.mockImplementation(() => vi.fn())
    getKernelSnapshot.mockResolvedValue({
      scope: { kind: 'global' },
      sequence: 0,
      state: {
        services: [],
        activeTurn: null,
        activeArtifactRun: null,
        chatTurns: [],
        activities: [],
        inferenceProfile: null,
      },
    } satisfies KernelSnapshot)
    globalThis.window = {
      electronAPI: {
        onKernelEvent,
        getKernelSnapshot,
        agentMode: { onExecuteTool },
      },
    } as unknown as Window & typeof globalThis
  })

  afterEach(async () => {
    const { unregisterAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
    unregisterAgentModeIpc()
  })

  it('subscribes the kernel stream and executeTool once each', async () => {
    const { registerAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
    registerAgentModeIpc(handlers)
    registerAgentModeIpc(handlers)
    expect(onKernelEvent).toHaveBeenCalledTimes(1)
    expect(onExecuteTool).toHaveBeenCalledTimes(1)
  })

  it('maps kernel events onto the per-kind handlers', async () => {
    const { registerAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
    let push: ((event: KernelEvent) => void) | undefined
    onKernelEvent.mockImplementation((listener: (event: KernelEvent) => void) => {
      push = listener
      return vi.fn()
    })
    registerAgentModeIpc(handlers)
    // Let the handshake install the snapshot (watermark 0) before pushing.
    await vi.waitFor(() => expect(handlers.onSnapshot).toHaveBeenCalledTimes(1))

    push?.({
      type: 'agent-chunk',
      turnId: 'turn-1',
      chunk: { type: 'text-start' },
      scope: { kind: 'run', runId: 'turn-1' },
      seq: 2,
    })
    expect(handlers.onStreamChunk).toHaveBeenCalledWith({
      turnId: 'turn-1',
      chunk: { type: 'text-start' },
    })
    push?.({
      type: 'agent-tool-progress',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'browser',
      text: 'navigating',
      scope: { kind: 'run', runId: 'turn-1' },
      seq: 3,
    })
    expect(handlers.onToolProgress).toHaveBeenCalledWith({
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'browser',
      text: 'navigating',
    })
    push?.({
      type: 'agent-tool-image',
      toolCallId: 'call-1',
      dataUri: 'data:image/png;base64,',
      label: 'cover.png',
      scope: { kind: 'run', runId: 'turn-1' },
      seq: 4,
    })
    expect(handlers.onToolImage).toHaveBeenCalledWith({
      toolCallId: 'call-1',
      dataUri: 'data:image/png;base64,',
      label: 'cover.png',
    })
    push?.({
      type: 'agent-turn-done',
      turnId: 'turn-1',
      scope: { kind: 'run', runId: 'turn-1' },
      seq: 5,
    })
    expect(handlers.onTurnDone).toHaveBeenCalledWith({ turnId: 'turn-1' })
    // A service event is not an agent event — no handler fires for it.
    push?.(serviceEvent)
    expect(handlers.onSnapshot).toHaveBeenCalledTimes(1)
  })

  it('installs the snapshot through the handshake', async () => {
    const { registerAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
    registerAgentModeIpc(handlers)
    await vi.waitFor(() => expect(handlers.onSnapshot).toHaveBeenCalledTimes(1))
    expect(handlers.onSnapshot).toHaveBeenCalledWith({
      scope: { kind: 'global' },
      sequence: 0,
      state: {
        services: [],
        activeTurn: null,
        activeArtifactRun: null,
        chatTurns: [],
        activities: [],
        inferenceProfile: null,
      },
    })
  })

  it('unsubscribes so the next register attaches fresh listeners', async () => {
    const { registerAgentModeIpc, unregisterAgentModeIpc } =
      await import('@/assets/js/store/agentModeIpc')
    const dispose = vi.fn()
    onKernelEvent.mockImplementation(() => dispose)
    registerAgentModeIpc(handlers)
    unregisterAgentModeIpc()
    expect(dispose).toHaveBeenCalledTimes(1)
    registerAgentModeIpc(handlers)
    expect(onKernelEvent).toHaveBeenCalledTimes(2)
  })
})
