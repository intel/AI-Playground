import { ArtifactRunRequestSchema } from '@/types/artifactIpc'
import type { MediaItem } from '@/types/mediaItem'
import type { ArtifactInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import type { appLoggerInstance } from '../../observability/logger'
import type { ArtifactRunPayload, cancelActiveArtifactRun } from '../../artifact/runner'
import type { cancelArtifactRun, submitArtifactRun } from '../../kernel/orchestrator'
import type { handleMediaResponse } from '../../artifact/rendererBridge'

/** The runner, orchestrator and bridge seams the three artifact handlers close over. */
export type ArtifactDeps = {
  appLogger: typeof appLoggerInstance
  submitArtifactRun: typeof submitArtifactRun
  cancelArtifactRun: typeof cancelArtifactRun
  cancelActiveArtifactRun: typeof cancelActiveArtifactRun
  handleMediaResponse: typeof handleMediaResponse
}

export function buildArtifactRegistry(deps: ArtifactDeps) {
  // Artifact runner IPC (architecture-target §4.1 step 5): the renderer ships
  // fully-resolved runs; the runner owns readiness, submission and the
  // progress stream back over the kernel bus.
  return {
    'artifact:run': async (_event, request, options) => {
      const parsed = ArtifactRunRequestSchema.safeParse(request)
      if (!parsed.success) {
        deps.appLogger.warn(
          `artifact:run rejected a malformed request: ${parsed.error.message}`,
          'electron-backend',
        )
        return { state: 'failed' as const, items: [], error: 'Malformed artifact run request' }
      }
      const payload: ArtifactRunPayload = {
        ...parsed.data,
        items: parsed.data.items as MediaItem[] | undefined,
        owner: { kind: 'panel' },
      }
      return deps.submitArtifactRun(payload, {
        queue: options?.queue === 'queue' ? 'queue' : 'fail-fast',
      })
    },

    'artifact:cancel': (_event, runId) => {
      if (typeof runId === 'string' && runId.length > 0) {
        deps.cancelArtifactRun(runId)
      } else {
        deps.cancelActiveArtifactRun()
      }
    },

    'artifact:respond': (_event, payload) => {
      deps.handleMediaResponse(payload)
    },
  } satisfies InvokeHandlerMap<ArtifactInvokeName>
}
