import { getMissingComfyuiBackendModels } from '@/assets/js/store/imageGenerationUtils'
import { requestDownload } from '@/assets/js/permissions/permissions'
import type { MediaRequestPayload, MediaResponsePayload } from '@/types/mediaRequests'

/**
 * Renderer half of the artifact pipeline's request/response seam (§4.1 step 5).
 *
 * The in-process agent tools and the artifact runner live in main, but the
 * model pre-flight (models store + HF token) and the download-consent prompt
 * (permissions layer) live here. Main sends `artifact:request` payloads and
 * waits for the reply by requestId; this module routes each kind to the
 * renderer code that can answer.
 */

// A consent dialog plus download can easily outlast the runner's 5-minute idle
// watchdog. Pings say "a human/renderer is actively working on it", not "bytes
// moved"; the watchdog exists to catch dead pipelines, and a window that dies
// rejects the request from main's side.
const PING_INTERVAL_MS = 30_000

function respond(payload: MediaResponsePayload): void {
  void window.electronAPI.artifact.respond(payload)
}

async function handleRequest(request: MediaRequestPayload): Promise<void> {
  const pings = setInterval(
    () => respond({ requestId: request.requestId, progress: true }),
    PING_INTERVAL_MS,
  )
  try {
    switch (request.kind) {
      case 'artifact-check-models': {
        // Throws on an inaccessible HF repo — forwarded as the request error
        // so main fails the run with the real reason instead of a missing-file
        // mystery later.
        const models = await getMissingComfyuiBackendModels(request.requiredModels)
        respond({ requestId: request.requestId, result: { models } })
        break
      }
      case 'artifact-consent': {
        try {
          await requestDownload(request.models)
          respond({ requestId: request.requestId, result: true })
        } catch (error) {
          // Declined or failed download: the runner cancels the run either
          // way; forwarding the message keeps the cause in main's log.
          respond({
            requestId: request.requestId,
            error: error instanceof Error ? error.message : 'Download declined',
          })
        }
        break
      }
    }
  } catch (error) {
    respond({
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearInterval(pings)
  }
}

let started = false

/**
 * Starts listening for main's artifact requests. Call once from the renderer
 * entry after pinia is installed — the handlers touch stores, but only when a
 * request arrives, which is always post-boot.
 */
export function startMediaRequestBridge(): void {
  if (started) return
  started = true
  window.electronAPI.artifact.onRequest((payload) => {
    void handleRequest(payload)
  })
}

// Test seam.
export function resetMediaRequestBridgeForTest(): void {
  started = false
}
