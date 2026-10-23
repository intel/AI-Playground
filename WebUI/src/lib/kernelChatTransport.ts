import type { ChatTransport, UIMessageChunk } from 'ai'
import type { ChatTurnRequest, ChatTurnResumeResult } from '@/types/chatIpc'
import type { KernelEvent } from '@/types/kernelEvents'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import { cloneForIpc } from '@/lib/cloneForIpc'

export type KernelChatTransportDeps = {
  submitTurn: (
    request: ChatTurnRequest,
  ) => Promise<{ success: true; turnId: string } | { success: false; error: string }>
  resumeTurn: (conversationKey: string) => Promise<ChatTurnResumeResult>
  cancelTurn: (conversationKey: string, turnId: string) => Promise<unknown>
  /** Live kernel events (the preload's `onKernelEvent` listener). */
  subscribe: (listener: (event: KernelEvent) => void) => () => void
  /** Every chunk that reaches a Chat stream, replay included (store-side
   *  activity/reasoning observation rides on this seam). */
  onChunk?: (chunk: UIMessageChunk) => void
  /** RAG sources after kernel retrieval (step 9). */
  onRag?: (conversationKey: string, sourceText: string | null) => void
}

type StreamState = {
  conversationKey: string
  /** Null until the submit/resume reply names the turn. */
  turnId: string | null
  /** Bus sequence; only events above it apply (0 for fresh submits). */
  minSeq: number
  /** Kernel events received before turnId was known. */
  pending: KernelEvent[]
  closed: boolean
  enqueue: ((chunk: UIMessageChunk) => void) | null
  onDone: (() => void) | null
  listener: (event: KernelEvent) => void
}

/**
 * The renderer half of step 6 (architecture-target §8): the AI SDK `Chat`
 * keeps its state machine, but its stream comes from the kernel bus instead
 * of an HTTP response. `sendMessages` posts the turn request over IPC and
 * returns a ReadableStream fed by `chat-chunk` events; the bus has already
 * coalesced adjacent deltas, so what crosses IPC here is close to what the
 * old custom fetch produced per token.
 *
 * Ordering across the submit/resume round trip is the subtle part: a turn can
 * emit its first chunk before the `chat:submitTurn` invoke resolves, and a
 * reconnecting renderer must not replay snapshot chunks as live events. Both
 * are handled by subscribing before the invoke and buffering everything until
 * the turnId is known — then draining the buffer once, gating resume events
 * by bus sequence (`seq > sequence` from the resume handshake).
 */
export function createKernelChatTransport(
  deps: KernelChatTransportDeps,
): ChatTransport<AipgUiMessage> {
  const streamListeners = new Set<(event: KernelEvent) => void>()
  let unsubscribe: (() => void) | null = null

  const ensureSubscribed = () => {
    if (unsubscribe) return
    unsubscribe = deps.subscribe((event) => {
      for (const listener of [...streamListeners]) listener(event)
    })
  }

  const removeStreamListener = (listener: (event: KernelEvent) => void) => {
    streamListeners.delete(listener)
    if (streamListeners.size === 0 && unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }

  const createStreamState = (conversationKey: string): StreamState => {
    const state: StreamState = {
      conversationKey,
      turnId: null,
      minSeq: 0,
      pending: [],
      closed: false,
      enqueue: null,
      onDone: null,
      listener: () => {},
    }
    state.listener = (event) => {
      if (state.turnId === null) {
        state.pending.push(event)
        return
      }
      if (state.closed) return
      if (
        (event.type === 'chat-chunk' ||
          event.type === 'chat-turn-done' ||
          event.type === 'chat-rag') &&
        event.conversationKey === state.conversationKey &&
        event.turnId === state.turnId &&
        event.seq > state.minSeq
      ) {
        if (event.type === 'chat-chunk') state.enqueue?.(event.chunk)
        else if (event.type === 'chat-turn-done') state.onDone?.()
        else deps.onRag?.(event.conversationKey, event.sourceText)
      }
    }
    streamListeners.add(state.listener)
    return state
  }

  const attachStream = (
    state: StreamState,
    replay: UIMessageChunk[],
    abortSignal: AbortSignal | undefined,
  ): ReadableStream<UIMessageChunk> => {
    const controllerRef: { controller?: ReadableStreamDefaultController<UIMessageChunk> } = {}
    const finish = () => {
      if (state.closed) return
      state.closed = true
      state.enqueue = null
      state.onDone = null
      removeStreamListener(state.listener)
      try {
        controllerRef.controller?.close()
      } catch {
        // The consumer may have torn the stream down first.
      }
    }
    state.enqueue = (chunk) => {
      deps.onChunk?.(chunk)
      controllerRef.controller?.enqueue(chunk)
    }
    state.onDone = finish
    void abortSignal?.addEventListener(
      'abort',
      () => {
        if (state.turnId) void deps.cancelTurn(state.conversationKey, state.turnId)
      },
      { once: true },
    )

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        controllerRef.controller = controller
        for (const chunk of replay) controller.enqueue(chunk)
        const drained = state.pending.splice(0)
        for (const event of drained) state.listener(event)
      },
      cancel() {
        finish()
      },
    })
  }

  return {
    async sendMessages(options) {
      ensureSubscribed()
      const state = createStreamState(options.chatId)
      try {
        const request = cloneForIpc({
          ...(options.body as Record<string, unknown> | undefined),
          conversationKey: options.chatId,
          trigger: options.trigger,
          messages: options.messages,
        }) as unknown as ChatTurnRequest
        const result = await deps.submitTurn(request)
        if (!result.success) throw new Error(result.error)
        state.turnId = result.turnId
        if (options.abortSignal?.aborted) {
          void deps.cancelTurn(state.conversationKey, state.turnId)
        }
        return attachStream(state, [], options.abortSignal)
      } catch (error) {
        removeStreamListener(state.listener)
        throw error
      }
    },

    async reconnectToStream(options) {
      ensureSubscribed()
      const state = createStreamState(options.chatId)
      try {
        const result = await deps.resumeTurn(options.chatId)
        if (!result.success || !result.active || !result.turnId || !result.chunks) {
          removeStreamListener(state.listener)
          return null
        }
        state.turnId = result.turnId
        state.minSeq = result.sequence ?? 0
        return attachStream(state, result.chunks, options.abortSignal)
      } catch {
        removeStreamListener(state.listener)
        return null
      }
    },
  }
}
