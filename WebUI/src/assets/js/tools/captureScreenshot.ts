import { tool } from 'ai'
import { z } from 'zod'
import { ToolConversationContextSchema } from './toolContext'

// Schema + description only. Capture runs in main
// (`electron/chat/chatScreenshotTool.ts`) against the window the turn request
// carries; the model-facing text is formatted there too.

export const captureScreenshot = tool({
  description:
    'Capture a screenshot of the single application window that the user has bound to this tool ' +
    'in AI Playground settings. Use it to visually verify or debug the result of actions you take ' +
    'in other applications (e.g. apps you drive via MCP tools). This tool takes no arguments and ' +
    'can ONLY capture the one pre-selected window — you cannot choose, list, or capture any other ' +
    'window or the full screen. The captured image is returned to you so you can inspect it.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    ok: z.boolean(),
    message: z.string(),
    windowName: z.string().optional(),
    // data:image/png;base64,... — kept so the chat UI can render the capture.
    dataUri: z.string().optional(),
  }),
  contextSchema: ToolConversationContextSchema,
})
