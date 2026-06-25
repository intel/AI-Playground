import { tool } from 'ai'
import { z } from 'zod'
import { useTextInference } from '../store/textInference'
import { useActivities } from '../store/activities'
import { useConversations } from '../store/conversations'

// The conversation a tool call belongs to is surfaced via `experimental_context`
// (set in openAiCompatibleChat's streamText call), used to scope the activity to
// the right chat turn. Mirrors the helper in configureHomeAgent.ts.
function conversationKeyFor(experimentalContext: unknown): string {
  const ctx = experimentalContext as { conversationKey?: string } | undefined
  return ctx?.conversationKey ?? useConversations().activeKey
}

const CaptureScreenshotOutputSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  windowName: z.string().optional(),
  // data:image/png;base64,... — kept so the chat UI can render the capture.
  dataUri: z.string().optional(),
})

type CaptureScreenshotOutput = z.infer<typeof CaptureScreenshotOutputSchema>

export const captureScreenshot = tool({
  description:
    'Capture a screenshot of the single application window that the user has bound to this tool ' +
    'in AI Playground settings. Use it to visually verify or debug the result of actions you take ' +
    'in other applications (e.g. apps you drive via MCP tools). This tool takes no arguments and ' +
    'can ONLY capture the one pre-selected window — you cannot choose, list, or capture any other ' +
    'window or the full screen. The captured image is returned to you so you can inspect it.',
  inputSchema: z.object({}),
  outputSchema: CaptureScreenshotOutputSchema,
  execute: async (_args, options): Promise<CaptureScreenshotOutput> => {
    const textInference = useTextInference()
    const activities = useActivities()
    const scope = {
      kind: 'chat' as const,
      conversationKey: conversationKeyFor(options.experimental_context),
    }

    const target = textInference.screenshotWindow
    if (!target) {
      return {
        ok: false,
        message:
          'No window is selected for screen capture. Ask the user to pick a window in AI Playground ' +
          'settings (Built-in tools → Capture screenshot) before using this tool.',
      }
    }

    return activities.track(
      { category: 'tools', label: 'Capturing screenshot…', scope },
      async () => {
        try {
          // `target` is a reactive Pinia proxy; pass a plain clone so Electron's IPC
          // structured-clone doesn't fail with "An object could not be cloned".
          const dataUri = await window.electronAPI.screenshot.captureWindow({
            id: target.id,
            name: target.name,
          })
          return {
            ok: true,
            message: `Captured a screenshot of "${target.name}".`,
            windowName: target.name,
            dataUri,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { ok: false, message }
        }
      },
    )
  },
  // The captured image is NOT returned to the model here: the OpenAI-compatible
  // backend JSON-stringifies tool-result content (so base64 would be sent as text,
  // not a vision image). Instead, openAiCompatibleChat's request post-processing
  // detects this tool's result and injects the capture as a real image message.
  // We only return short text so no base64 ever leaks into the tool message.
  toModelOutput: ({ output }) => {
    if (!output.ok) {
      return { type: 'error-text', value: output.message }
    }
    return { type: 'text', value: output.message }
  },
})
