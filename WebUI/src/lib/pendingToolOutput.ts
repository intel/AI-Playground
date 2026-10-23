import type { UIMessageChunk } from 'ai'

/**
 * The AI SDK can emit `tool-output-available` with `output: null` before a
 * long execute (Comfy) settles. Hold the real promise and fill the chunk in.
 */
export async function settleToolOutput(
  pending: Map<string, Promise<unknown>>,
  toolCallId: string,
  output: unknown,
): Promise<unknown> {
  if (output != null) return output
  const work = pending.get(toolCallId)
  if (!work) return output
  return await work
}

export async function fillToolResultOutput(
  pending: Map<string, Promise<unknown>>,
  toolCallId: string,
  toolOutput: { type: string; output?: unknown },
): Promise<void> {
  if (toolOutput.type !== 'tool-result') return
  try {
    toolOutput.output = await settleToolOutput(pending, toolCallId, toolOutput.output)
  } catch {
    // executeToolCall already records a tool-error when execute rejects
  }
}

export function patchUiToolOutputs(
  stream: ReadableStream<UIMessageChunk>,
  pending: Map<string, Promise<unknown>>,
): ReadableStream<UIMessageChunk> {
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      async transform(chunk, controller) {
        if (chunk.type === 'tool-output-available' && chunk.output == null) {
          const work = pending.get(chunk.toolCallId)
          if (work) {
            try {
              controller.enqueue({ ...chunk, output: await work })
              return
            } catch {
              // keep the empty output
            }
          }
        }
        controller.enqueue(chunk)
      },
    }),
  )
}
