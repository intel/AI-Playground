/**
 * Main → renderer request/response seam for the artifact pipeline (step 5).
 *
 * The in-process agent tools run beside the runner in main, but the model
 * pre-flight (models store + HF token) and the download-consent prompt
 * (permissions layer) live renderer-side. Rather than duplicating that state
 * into main, main asks the renderer over one channel and waits for the reply
 * by requestId — the same trust direction as `agentMode:executeTool`, inverted.
 */
import { randomUUID } from 'node:crypto'
import { getKernelEventWindow } from '../kernel/kernelBus'
import { typedSend } from '../kernel/typedIpc'
import type { MediaRequestBody, MediaResponsePayload } from '@/types/mediaRequests'

type PendingRequest = {
  requestId: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  onProgress?: () => void
}

const pending = new Map<string, PendingRequest>()

export type RequestRendererOptions = {
  /** Called on each `{ progress: true }` ping — the runner re-arms its watchdog. */
  onProgress?: () => void
}

/**
 * Sends a request to the current renderer window and awaits its reply.
 * Rejects when the renderer reports an error, when no window is available, or
 * when the window changes (the old renderer can no longer answer).
 */
export function requestRenderer<T>(
  payload: MediaRequestBody,
  options: RequestRendererOptions = {},
): Promise<T> {
  const win = getKernelEventWindow()
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('No renderer window available for the request'))
  }
  const requestId = randomUUID()
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, {
      requestId,
      resolve: resolve as (result: unknown) => void,
      reject,
      onProgress: options.onProgress,
    })
    try {
      typedSend(win.webContents, 'artifact:request', { ...payload, requestId })
    } catch (error) {
      pending.delete(requestId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** Wired to the `artifact:respond` IPC channel in main. */
export function handleMediaResponse(payload: MediaResponsePayload): void {
  if (typeof payload?.requestId !== 'string') return
  const entry = pending.get(payload.requestId)
  if (!entry) return
  if ('progress' in payload) {
    entry.onProgress?.()
    return
  }
  pending.delete(payload.requestId)
  if ('error' in payload) {
    entry.reject(new Error(payload.error))
  } else {
    entry.resolve(payload.result)
  }
}

/**
 * Settles every outstanding request — main calls this when the kernel window
 * changes, because the renderer that was asked can no longer reply.
 */
export function rejectAllMediaRequests(reason: string): void {
  for (const entry of pending.values()) {
    entry.reject(new Error(reason))
  }
  pending.clear()
}

// Test seam.
export function resetRendererBridgeForTest(): void {
  pending.clear()
}

export function mediaRequestsPending(): number {
  return pending.size
}
