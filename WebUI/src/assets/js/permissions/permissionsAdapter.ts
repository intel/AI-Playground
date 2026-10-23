import { useDialogStore } from '../store/dialogs'
import { remoteTurnPort } from './remoteTurnPort'
import { extractMessage, isCancellation } from '../errors/appError'

/**
 * Renderer half of the Permissions prompt adapter (step 13). Main owns grant
 * lookup and skip-confirmation; this module shows the desktop modal, routes a
 * remote turn to the registered Home Agent port, and asks the VRAM warning.
 * `notify` stays local — it is display-only, not a consent decision.
 */

const PING_INTERVAL_MS = 30_000

function respond(payload: import('@/types/permissionsIpc').PermissionsPromptResponse): void {
  void window.electronAPI.permissions.respond(payload)
}

async function handlePrompt(
  request: import('@/types/permissionsIpc').PermissionsPromptPayload,
): Promise<void> {
  const pings = setInterval(
    () => respond({ requestId: request.requestId, progress: true }),
    PING_INTERVAL_MS,
  )
  try {
    switch (request.kind) {
      case 'is-remote': {
        respond({ requestId: request.requestId, result: remoteTurnPort().isActive() })
        break
      }
      case 'download': {
        const models = request.models as DownloadModelParam[]
        if (remoteTurnPort().isActive()) {
          await remoteTurnPort().downloadModels(models, {
            skipConfirmation: request.skipConfirmation,
          })
        } else {
          await new Promise<void>((resolve, reject) => {
            useDialogStore().showDownloadDialog(models, resolve, reject)
          })
        }
        respond({ requestId: request.requestId, result: true })
        break
      }
      case 'vram-warning': {
        const answer = await new Promise<{ confirmed: boolean; remember: boolean }>((resolve) => {
          useDialogStore().showWarningDialog(
            request.message,
            (dontShowAgain) => resolve({ confirmed: true, remember: Boolean(dontShowAgain) }),
            {
              dontShowAgainKey: request.presetName,
              onCancel: () => resolve({ confirmed: false, remember: false }),
            },
          )
        })
        respond({ requestId: request.requestId, result: answer })
        break
      }
    }
  } catch (error) {
    // An AppError is a plain object, so `String(error)` here was the
    // "[object Object]" a declined in-channel download used to surface as.
    respond({
      requestId: request.requestId,
      error: extractMessage(error),
      cancelled: isCancellation(error),
    })
  } finally {
    clearInterval(pings)
  }
}

let started = false

export function startPermissionsAdapter(): void {
  if (started) return
  started = true
  window.electronAPI.permissions.onPrompt((payload) => {
    void handlePrompt(payload)
  })
}

export function resetPermissionsAdapterForTest(): void {
  started = false
}
