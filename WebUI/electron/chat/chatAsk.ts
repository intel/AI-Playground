import { randomUUID } from 'node:crypto'
import { getKernelEventWindow } from '../kernel/kernelBus'
import { typedSend } from '../kernel/typedIpc'
import type { ChatAnswerPayload, ChatAskBody, ChatAskPhase } from '@/types/chatRequests'

/**
 * Main half of the chat tools' question channel — the same trust direction as
 * `artifact:request`, on its own channel so an answer can never be mistaken for
 * an artifact one.
 *
 * See `@/types/chatRequests` for what main asks the renderer and why.
 */

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  onPhase?: (phase: ChatAskPhase) => void
}

const pending = new Map<string, PendingRequest>()

export function askRenderer<T>(
  body: ChatAskBody,
  options: { onPhase?: (phase: ChatAskPhase) => void; abortSignal?: AbortSignal } = {},
): Promise<T> {
  const win = getKernelEventWindow()
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('No renderer window available for the request'))
  }
  if (options.abortSignal?.aborted) {
    return Promise.reject(new Error('The turn was cancelled'))
  }
  const requestId = randomUUID()
  return new Promise<T>((resolve, reject) => {
    // A cancelled turn must not leave the tool awaiting an answer nobody will
    // give: the renderer settles its own card, and a late answer finds no entry.
    const onAbort = () => {
      pending.delete(requestId)
      reject(new Error('The turn was cancelled'))
    }
    options.abortSignal?.addEventListener('abort', onAbort, { once: true })
    pending.set(requestId, {
      resolve: (result) => {
        options.abortSignal?.removeEventListener('abort', onAbort)
        ;(resolve as (value: unknown) => void)(result)
      },
      reject: (error) => {
        options.abortSignal?.removeEventListener('abort', onAbort)
        reject(error)
      },
      onPhase: options.onPhase,
    })
    try {
      typedSend(win.webContents, 'chat:ask', { ...body, requestId })
    } catch (error) {
      pending.delete(requestId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** Wired to the `chat:answer` IPC channel in main. */
export function handleChatAnswer(payload: ChatAnswerPayload): void {
  if (typeof payload?.requestId !== 'string') return
  const entry = pending.get(payload.requestId)
  if (!entry) return
  if ('progress' in payload) {
    if (payload.phase) entry.onPhase?.(payload.phase)
    return
  }
  pending.delete(payload.requestId)
  if ('error' in payload) {
    entry.reject(new Error(payload.error))
  } else {
    entry.resolve(payload.result)
  }
}

/** Settles every outstanding question — the renderer that was asked is gone. */
export function rejectAllChatAsks(reason: string): void {
  for (const entry of pending.values()) entry.reject(new Error(reason))
  pending.clear()
}

// Test seam.
export function resetChatAskForTest(): void {
  pending.clear()
}

export function chatAsksPending(): number {
  return pending.size
}
