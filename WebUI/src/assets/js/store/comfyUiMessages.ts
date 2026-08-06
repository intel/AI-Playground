import { z } from 'zod'

// Schema for the messages ComfyUI pushes over its WebSocket during execution.
export const ComfyMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
  }),
  z.object({
    type: z.literal('execution_start'),
    data: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal('execution_success'),
    data: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal('execution_error'),
    data: z
      .object({
        exception_message: z.string().optional(),
        exception_type: z.string().optional(),
        node_id: z.union([z.string(), z.number()]).optional(),
        node_type: z.string().optional(),
        traceback: z.array(z.string()).optional(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal('execution_interrupted'),
    data: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal('execution_cached'),
    data: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal('progress'),
    data: z
      .object({
        value: z.number(),
        max: z.number(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal('executing'),
    data: z
      .object({
        node: z.string().nullable().optional(),
        display_node: z.string().optional(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal('executed'),
    data: z
      .object({
        output: z.union([
          z.object({
            images: z.array(
              z.object({
                filename: z.string(),
                subfolder: z.string(),
                type: z.string(),
              }),
            ),
            animated: z.array(z.boolean()).optional(),
          }),
          z.object({
            gifs: z.array(
              z.object({
                filename: z.string(),
                workflow: z.string(),
                type: z.string(),
                subfolder: z.string(),
                format: z.string(),
              }),
            ),
          }),
          z.object({
            '3d': z.array(
              z.object({
                filename: z.string(),
                subfolder: z.string(),
                type: z.string(),
              }),
            ),
          }),
        ]),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal('progress_state'),
    data: z.object({}).passthrough(),
  }),
])

export type ComfyExecutionErrorData = {
  exception_message?: string
  exception_type?: string
  node_id?: string | number
  node_type?: string
  traceback?: string[]
}

// ComfyUI reports node failures with a full Python exception (often a multi-KB
// state_dict / size-mismatch dump). That is useless and overwhelming as a
// user-facing string, so we map the common, recognizable failures to a short,
// actionable sentence and keep the raw detail for the logs/debug panel only.
export function summarizeComfyExecutionError(data: ComfyExecutionErrorData): string {
  const raw = (data.exception_message ?? '').trim()
  const lower = raw.toLowerCase()
  const type = (data.exception_type ?? '').toLowerCase()

  if (
    lower.includes('size mismatch') ||
    lower.includes('error(s) in loading state_dict') ||
    lower.includes('load_state_dict')
  ) {
    return "The selected model doesn't match this workflow (mismatched weights while loading). Pick a model that fits the preset, or choose a different preset."
  }
  if (
    lower.includes('out of memory') ||
    lower.includes('outofmemory') ||
    lower.includes('failed to allocate') ||
    (lower.includes('alloc') && lower.includes('memory'))
  ) {
    return 'Ran out of memory while generating. Try a smaller resolution or batch size.'
  }
  if (
    type.includes('filenotfound') ||
    lower.includes('no such file') ||
    lower.includes('cannot find') ||
    lower.includes('does not exist')
  ) {
    return 'A required model or file could not be found. Make sure the needed models are downloaded.'
  }

  // Fallback: first meaningful line of the exception, trimmed to a sane length.
  const firstLine =
    raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  const concise = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
  const prefix = data.node_type ? `${data.node_type}: ` : ''
  return concise ? `${prefix}${concise}` : 'The workflow failed during execution.'
}
