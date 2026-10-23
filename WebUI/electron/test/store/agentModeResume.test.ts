import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTurnSnapshot, KernelEvent, KernelSnapshot } from '@/types/kernelEvents'
import type { IpcMutationResult } from '@/types/ipcChannels'

// The renderer half of the hidden-window lifecycle: a window that (re)connects
// while main is mid-turn adopts that turn from the kernel snapshot — the
// accumulated chunks replay as the resumed stream's opening content, live
// events append, and the turn's done event settles processing.

let pushKernelEvent: (event: KernelEvent) => void = () => {}
let resolveSnapshot: (snapshot: KernelSnapshot) => void = () => {}

const RUNNING_TURN: AgentTurnSnapshot = {
  turnId: 'turn-3',
  chunks: [
    { type: 'start', id: 'msg-1', message: { id: 'msg-1', role: 'assistant', parts: [] } },
    { type: 'text-start', id: 'part-1' },
    { type: 'text-delta', id: 'part-1', delta: 'hello ' },
  ],
  toolProgress: { 'call-1': 'navigating' },
  toolImages: {
    'call-1': [
      {
        type: 'agent-tool-image',
        toolCallId: 'call-1',
        dataUri: 'data:image/png;base64,',
        label: 'cover.png',
      },
    ],
  },
}

function kernelEventOf(payload: Record<string, unknown>, seq: number): KernelEvent {
  return { ...payload, scope: { kind: 'run', runId: 'turn-3' }, seq } as KernelEvent
}

const startTurn = vi.fn(
  async (_turnId: string, _prompt: string, _config: unknown): Promise<IpcMutationResult> => ({
    success: true,
  }),
)
const cancelTurn = vi.fn(async () => {})

const reported: unknown[] = []
const report = vi.fn((error: unknown) => void reported.push(error))

beforeEach(() => {
  vi.clearAllMocks()
  pushKernelEvent = () => {}
  resolveSnapshot = () => {}
  globalThis.window = {
    electronAPI: {
      onKernelEvent: vi.fn((listener: (event: KernelEvent) => void) => {
        pushKernelEvent = listener
        return () => {}
      }),
      getKernelSnapshot: vi.fn(
        () =>
          new Promise<KernelSnapshot>((resolve) => {
            resolveSnapshot = resolve
          }),
      ),
      setLifecycleBusy: vi.fn(),
      agentMode: {
        onExecuteTool: vi.fn(),
        submitToolResult: vi.fn(),
        startTurn,
        cancel: cancelTurn,
      },
    },
  } as unknown as Window & typeof globalThis
})

afterEach(async () => {
  const { unregisterAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
  unregisterAgentModeIpc()
})

async function freshRuntime() {
  const { createAgentTurnRuntime } = await import('@/assets/js/store/agentModeTurn')
  return {
    runtime: createAgentTurnRuntime({
      errors: { report },
      buildTurnConfig: async () => ({}) as never,
    }),
  }
}

function snapshotWithTurn(sequence: number, activeTurn: typeof RUNNING_TURN | null) {
  return {
    scope: { kind: 'global' } as const,
    sequence,
    state: {
      services: [],
      activeTurn,
      activeArtifactRun: null,
      chatTurns: [],
      activities: [],
      inferenceProfile: null,
    },
  }
}

describe('agent turn resume', () => {
  it('adopts a running turn: replays chunks, restores progress, appends live events', async () => {
    const { runtime } = await freshRuntime()
    resolveSnapshot(snapshotWithTurn(5, RUNNING_TURN))

    await vi.waitFor(() => expect(runtime.processing.value).toBe(true))
    expect(runtime.toolProgress.value['call-1']).toBe('navigating')
    expect(runtime.toolImages.value['call-1']).toHaveLength(1)

    // The snapshot's accumulated chunks built the in-flight message...
    await vi.waitFor(() => expect(JSON.stringify(runtime.chat.messages)).toContain('hello '))

    // ...and live events above the watermark append.
    pushKernelEvent(
      kernelEventOf(
        {
          type: 'agent-chunk',
          turnId: 'turn-3',
          chunk: { type: 'text-delta', id: 'part-1', delta: 'world' },
        },
        6,
      ),
    )
    await vi.waitFor(() => expect(JSON.stringify(runtime.chat.messages)).toContain('world'))

    // The done event closes the stream and clears processing.
    pushKernelEvent(kernelEventOf({ type: 'agent-turn-done', turnId: 'turn-3' }, 7))
    await vi.waitFor(() => expect(runtime.processing.value).toBe(false))
  })

  it('never mints a colliding turn id after adopting', async () => {
    const { runtime } = await freshRuntime()
    resolveSnapshot(snapshotWithTurn(5, RUNNING_TURN))
    await vi.waitFor(() => expect(runtime.processing.value).toBe(true))
    pushKernelEvent(kernelEventOf({ type: 'agent-turn-done', turnId: 'turn-3' }, 7))
    await vi.waitFor(() => expect(runtime.processing.value).toBe(false))

    // A fresh send must not reuse turn-3's id range.
    runtime.chat.sendMessage({ text: 'next request' })
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled())
    const turnId = startTurn.mock.calls.at(-1)?.[0]
    expect(turnId).toBe('turn-4')
  })

  it('does not resume when the snapshot has no running turn', async () => {
    const { runtime } = await freshRuntime()
    resolveSnapshot(snapshotWithTurn(5, null))
    await Promise.resolve()
    expect(runtime.processing.value).toBe(false)
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('does not adopt a turn whose done event arrived during the handshake', async () => {
    const { runtime } = await freshRuntime()
    // Buffered behind the handshake, so its seq is above the watermark —
    // but the install runs first and reconnect still must not hang a dead
    // turn open.
    pushKernelEvent(kernelEventOf({ type: 'agent-turn-done', turnId: 'turn-3' }, 6))
    resolveSnapshot(snapshotWithTurn(5, RUNNING_TURN))

    await vi.waitFor(() => expect(JSON.stringify(runtime.chat.messages)).toContain('hello '))
    // The turnDone flushed after install; processing settles without a hang.
    await vi.waitFor(() => expect(runtime.processing.value).toBe(false))
    expect(reported).toHaveLength(0)
  })
})
