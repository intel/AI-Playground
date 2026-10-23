import { describe, expect, it, vi } from 'vitest'
import type { UIMessageChunk } from 'ai'
import type { ChatTurnRequest, ChatTurnResumeResult } from '@/types/chatIpc'
import type { KernelEvent } from '@/types/kernelEvents'
import { createKernelChatTransport } from '@/lib/kernelChatTransport'

const chunkEvent = (
  seq: number,
  conversationKey: string,
  turnId: string,
  chunk: UIMessageChunk,
): KernelEvent =>
  ({
    type: 'chat-chunk',
    conversationKey,
    turnId,
    chunk,
    scope: { kind: 'chat', conversationKey },
    seq,
  }) as KernelEvent

const doneEvent = (seq: number, conversationKey: string, turnId: string): KernelEvent =>
  ({
    type: 'chat-turn-done',
    conversationKey,
    turnId,
    scope: { kind: 'chat', conversationKey },
    seq,
  }) as KernelEvent

const ragEvent = (
  seq: number,
  conversationKey: string,
  turnId: string,
  sourceText: string | null,
): KernelEvent =>
  ({
    type: 'chat-rag',
    conversationKey,
    turnId,
    sourceText,
    scope: { kind: 'chat', conversationKey },
    seq,
  }) as KernelEvent

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type SubmitTurnFn = (
  request: ChatTurnRequest,
) => Promise<{ success: true; turnId: string } | { success: false; error: string }>

type Harness = {
  submitTurn: ReturnType<typeof vi.fn<SubmitTurnFn>>
  resumeTurn: ReturnType<typeof vi.fn<(key: string) => Promise<ChatTurnResumeResult>>>
  cancelTurn: ReturnType<typeof vi.fn<(key: string, turnId: string) => Promise<unknown>>>
  subscribe: ReturnType<typeof vi.fn<(listener: (event: KernelEvent) => void) => () => void>>
  unsubscribe: ReturnType<typeof vi.fn>
  emit: (event: KernelEvent) => void
}

function createHarness(): Harness {
  let kernelListener: ((event: KernelEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((listener: (event: KernelEvent) => void) => {
    kernelListener = listener
    return unsubscribe
  })
  return {
    submitTurn:
      vi.fn<
        (
          request: ChatTurnRequest,
        ) => Promise<{ success: true; turnId: string } | { success: false; error: string }>
      >(),
    resumeTurn: vi.fn<(conversationKey: string) => Promise<ChatTurnResumeResult>>(),
    cancelTurn: vi.fn<(conversationKey: string, turnId: string) => Promise<unknown>>(),
    subscribe,
    unsubscribe,
    emit: (event) => kernelListener?.(event),
  }
}

async function readAll(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader()
  const chunks: UIMessageChunk[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

const submitOptions = (overrides: Record<string, unknown> = {}) =>
  ({
    trigger: 'submit-message' as const,
    chatId: 'conv-1',
    messageId: undefined,
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    abortSignal: undefined,
    ...overrides,
  }) as Parameters<ReturnType<typeof createKernelChatTransport>['sendMessages']>[0]

describe('kernel chat transport', () => {
  it('submits the turn over IPC and streams kernel chunks in order', async () => {
    const h = createHarness()
    h.submitTurn.mockResolvedValue({ success: true, turnId: 't1' })
    const transport = createKernelChatTransport(h)

    const stream = await transport.sendMessages(
      submitOptions({ body: { systemPrompt: 'sys', model: { backend: 'llamaCPP' } } }),
    )
    expect(h.submitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: 'conv-1',
        trigger: 'submit-message',
        systemPrompt: 'sys',
        model: { backend: 'llamaCPP' },
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    )

    const collected = readAll(stream)
    h.emit(chunkEvent(1, 'conv-1', 't1', { type: 'start' }))
    h.emit(chunkEvent(2, 'conv-1', 't1', { type: 'text-delta', id: 'txt-0', delta: 'Hello' }))
    h.emit(doneEvent(3, 'conv-1', 't1'))
    expect(await collected).toEqual([
      { type: 'start' },
      { type: 'text-delta', id: 'txt-0', delta: 'Hello' },
    ])
  })

  it('buffers chunks that cross the IPC reply and does not lose them', async () => {
    const h = createHarness()
    const gate = deferred<{ success: true; turnId: string }>()
    h.submitTurn.mockReturnValue(gate.promise)
    const transport = createKernelChatTransport(h)

    const pending = transport.sendMessages(submitOptions())
    // The turn starts streaming in main before the submit reply reaches us.
    h.emit(chunkEvent(1, 'conv-1', 't1', { type: 'start' }))
    h.emit(chunkEvent(2, 'conv-1', 't1', { type: 'text-delta', id: 'txt-0', delta: 'early' }))
    gate.resolve({ success: true, turnId: 't1' })

    const stream = await pending
    const collected = readAll(stream)
    h.emit(chunkEvent(3, 'conv-1', 't1', { type: 'text-delta', id: 'txt-0', delta: 'late' }))
    h.emit(doneEvent(4, 'conv-1', 't1'))
    expect(await collected).toEqual([
      { type: 'start' },
      { type: 'text-delta', id: 'txt-0', delta: 'early' },
      { type: 'text-delta', id: 'txt-0', delta: 'late' },
    ])
  })

  it('rejects sendMessages when submission fails and drops its listener', async () => {
    const h = createHarness()
    h.submitTurn.mockResolvedValue({ success: false, error: 'a turn is already running' })
    const transport = createKernelChatTransport(h)

    await expect(transport.sendMessages(submitOptions())).rejects.toThrow(
      'a turn is already running',
    )
    // The last stream gone also unsubscribes the kernel listener.
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('forwards abort to cancelTurn once the turnId is known', async () => {
    const h = createHarness()
    h.submitTurn.mockResolvedValue({ success: true, turnId: 't1' })
    const transport = createKernelChatTransport(h)
    const controller = new AbortController()

    const stream = await transport.sendMessages(submitOptions({ abortSignal: controller.signal }))
    controller.abort()
    expect(h.cancelTurn).toHaveBeenCalledWith('conv-1', 't1')
    void stream
  })

  it('cancels a turn whose signal was already aborted at submit time', async () => {
    const h = createHarness()
    h.submitTurn.mockResolvedValue({ success: true, turnId: 't1' })
    const transport = createKernelChatTransport(h)

    await transport.sendMessages(submitOptions({ abortSignal: AbortSignal.abort() }))
    expect(h.cancelTurn).toHaveBeenCalledWith('conv-1', 't1')
  })

  it('ignores chunks and done events for other conversations or turns', async () => {
    const h = createHarness()
    h.submitTurn.mockResolvedValue({ success: true, turnId: 't1' })
    const transport = createKernelChatTransport(h)

    const stream = await transport.sendMessages(submitOptions())
    const collected = readAll(stream)
    h.emit(chunkEvent(1, 'conv-2', 't1', { type: 'start' }))
    h.emit(chunkEvent(2, 'conv-1', 'tX', { type: 'text-delta', id: 'txt-0', delta: 'nope' }))
    h.emit(doneEvent(3, 'conv-1', 'tX'))
    h.emit(chunkEvent(4, 'conv-1', 't1', { type: 'text-delta', id: 'txt-0', delta: 'mine' }))
    h.emit(doneEvent(5, 'conv-1', 't1'))
    expect(await collected).toEqual([{ type: 'text-delta', id: 'txt-0', delta: 'mine' }])
  })

  it('replays the resume snapshot, then only events above the sequence', async () => {
    const h = createHarness()
    const gate = deferred<ChatTurnResumeResult>()
    h.resumeTurn.mockReturnValue(gate.promise)
    const transport = createKernelChatTransport(h)

    const pending = transport.reconnectToStream({ chatId: 'conv-1', abortSignal: undefined })
    // Events that raced the handshake: below the snapshot sequence (dup) and
    // above it (new) — both land in the buffer before the reply arrives.
    h.emit(chunkEvent(9, 'conv-1', 't9', { type: 'text-delta', id: 'txt-0', delta: 'dup' }))
    h.emit(chunkEvent(11, 'conv-1', 't9', { type: 'text-delta', id: 'txt-0', delta: 'live' }))
    gate.resolve({
      success: true,
      active: true,
      turnId: 't9',
      sequence: 10,
      chunks: [{ type: 'start' }, { type: 'text-delta', id: 'txt-0', delta: 'snapshot' }],
    })

    const stream = await pending
    const collected = readAll(stream as ReadableStream<UIMessageChunk>)
    h.emit(doneEvent(12, 'conv-1', 't9'))
    expect(await collected).toEqual([
      { type: 'start' },
      { type: 'text-delta', id: 'txt-0', delta: 'snapshot' },
      { type: 'text-delta', id: 'txt-0', delta: 'live' },
    ])
  })

  it('returns null when no turn is active on reconnect', async () => {
    const h = createHarness()
    h.resumeTurn.mockResolvedValue({ success: true, active: false })
    const transport = createKernelChatTransport(h)

    expect(
      await transport.reconnectToStream({ chatId: 'conv-1', abortSignal: undefined }),
    ).toBeNull()
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('reports every chunk through the onChunk seam', async () => {
    const h = createHarness()
    h.submitTurn.mockResolvedValue({ success: true, turnId: 't1' })
    const seen: UIMessageChunk[] = []
    const transport = createKernelChatTransport({ ...h, onChunk: (c) => void seen.push(c) })

    const stream = await transport.sendMessages(submitOptions())
    const collected = readAll(stream)
    h.emit(chunkEvent(1, 'conv-1', 't1', { type: 'text-delta', id: 'txt-0', delta: 'x' }))
    h.emit(doneEvent(2, 'conv-1', 't1'))
    await collected
    expect(seen).toEqual([{ type: 'text-delta', id: 'txt-0', delta: 'x' }])
  })

  it('forwards chat-rag through onRag, including events that raced the submit reply', async () => {
    const h = createHarness()
    const gate = deferred<{ success: true; turnId: string }>()
    h.submitTurn.mockReturnValue(gate.promise)
    const seen: Array<{ key: string; source: string | null }> = []
    const transport = createKernelChatTransport({
      ...h,
      onRag: (key, sourceText) => void seen.push({ key, source: sourceText }),
    })

    const pending = transport.sendMessages(submitOptions())
    h.emit(ragEvent(1, 'conv-1', 't1', 'doc.txt'))
    gate.resolve({ success: true, turnId: 't1' })
    const stream = await pending
    const collected = readAll(stream)
    h.emit(doneEvent(2, 'conv-1', 't1'))
    await collected
    expect(seen).toEqual([{ key: 'conv-1', source: 'doc.txt' }])
  })

  it('unsubscribes from the kernel stream when the last stream settles', async () => {
    const h = createHarness()
    h.submitTurn.mockResolvedValue({ success: true, turnId: 't1' })
    const transport = createKernelChatTransport(h)

    const stream = await transport.sendMessages(submitOptions())
    const collected = readAll(stream)
    h.emit(doneEvent(1, 'conv-1', 't1'))
    await collected
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)

    // A second turn re-subscribes rather than relying on a dead subscription.
    h.submitTurn.mockResolvedValue({ success: true, turnId: 't2' })
    const stream2 = await transport.sendMessages(submitOptions())
    const collected2 = readAll(stream2)
    h.emit(chunkEvent(2, 'conv-1', 't2', { type: 'text-delta', id: 'txt-0', delta: 'again' }))
    h.emit(doneEvent(3, 'conv-1', 't2'))
    expect(await collected2).toEqual([{ type: 'text-delta', id: 'txt-0', delta: 'again' }])
  })
})
