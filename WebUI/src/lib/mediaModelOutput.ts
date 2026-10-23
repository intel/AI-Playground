import type { ToolResultOutput } from '@ai-sdk/provider-utils'

/**
 * Model-facing condensation of a media tool result: summary + step lines +
 * slim image refs (id/type/url only — no settings payloads). Used live
 * (`toModelOutput` in the media tool), when replaying persisted history (the
 * chat turn engine's request post-processing), and must be importable from
 * the main process — hence living in a lib, not the store-laden tools module.
 */
export type SlimMediaToolOutput = {
  success?: boolean
  message?: string
  summary: string
  steps: string[]
  images: Array<{
    id: string
    type: string
    imageUrl?: string
    videoUrl?: string
    model3dUrl?: string
  }>
}

export function slimMediaModelOutput(output: SlimMediaToolOutput): ToolResultOutput {
  if (output.success === false || output.images.length === 0) {
    return {
      type: 'error-text',
      value: output.message ?? output.summary ?? 'Media generation failed.',
    }
  }
  return {
    type: 'json',
    value: {
      summary: output.summary,
      steps: output.steps,
      images: output.images.map((item) => {
        const slim: Record<string, string> = { id: item.id, type: item.type }
        if (item.imageUrl) slim.imageUrl = item.imageUrl
        if (item.videoUrl) slim.videoUrl = item.videoUrl
        if (item.model3dUrl) slim.model3dUrl = item.model3dUrl
        return slim
      }),
    },
  }
}
