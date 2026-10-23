import { useDialogStore } from '../store/dialogs'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { REMOTE_DOWNLOAD_GRANT, vramWarningGrantKey } from '@/types/permissionsIpc'
import { createCancellation } from '../errors/appError'

/**
 * Permissions — the consent layer (§4.7 of docs/architecture-target.md, step 13).
 * Policy (grant lookup, skip-confirmation) lives in main. This module is the
 * named-verb facade the rest of the renderer calls:
 *
 * - `requestDownload` — model-download consent. Main decides whether a remote
 *   Home Agent turn may skip the in-channel question (`download:remote-turns`
 *   pre-grant); the renderer adapter shows the modal or routes to the channel.
 * - `requestVramWarning` — the gated high-memory / video-VRAM preset warning.
 *   "Do not show again" becomes a `remember` grant in main.
 * - `notify` — one-way guidance (an install-needed notice whose Confirm opens
 *   the setup wizard). No grant, nothing to remember; stays renderer-local.
 *
 * There is no silent auto-allow. Named verbs stay; grant vocabulary is not
 * this row. The Home Agent store is never imported here — a remote turn
 * registers a port (`remoteTurnPort.ts`) that the adapter consults.
 */

export { REMOTE_DOWNLOAD_GRANT, vramWarningGrantKey }

/**
 * Ask consent for downloading the given models and run the download.
 * Resolves when the download completed; rejects when it was declined or
 * failed. On a remote Home Agent turn the request is answered in-channel
 * (mirrored on the desktop); the `download:remote-turns` pre-grant skips the
 * in-channel question — gated models are still declined, progress still
 * streams to the channel.
 */
export async function requestDownload(models: DownloadModelParam[]): Promise<void> {
  const api = window.electronAPI?.permissions
  if (!api?.requestDownload) {
    throw new Error('Permissions policy is unavailable (no electron bridge)')
  }
  const result = await api.requestDownload(cloneForIpc(models))
  if (result.success) return
  // A decline is a cancellation on the way out and has to still be one here, or
  // the caller reports "Could not start generation" for a turn the user stopped.
  if (result.cancelled) throw createCancellation({ technicalMessage: result.error })
  throw new Error(result.error)
}

/**
 * The gated-preset (high-memory / video-VRAM) warning. Resolves `true` when
 * the user confirms (or had remembered/pre-granted the warning away), `false`
 * when they cancel. A confirmed "do not show again" records a `remember`
 * grant under `vram-warning:<presetName>`.
 */
export async function requestVramWarning(req: {
  presetName: string
  message: string
}): Promise<boolean> {
  const api = window.electronAPI?.permissions
  if (!api?.requestVramWarning) {
    throw new Error('Permissions policy is unavailable (no electron bridge)')
  }
  const result = await api.requestVramWarning(req)
  if (!result.success) throw new Error(result.error)
  return result.confirmed
}

/** One-way guidance notice; `onConfirm` runs when the user clicks Confirm
 *  (e.g. opening the setup wizard to install what is missing). */
export function notify(message: string, onConfirm?: () => void): void {
  useDialogStore().showWarningDialog(message, () => onConfirm?.())
}
