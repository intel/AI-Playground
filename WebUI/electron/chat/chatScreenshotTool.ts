import { captureWindow, type CaptureTarget } from '../adapters/hardware/screenCapture'
import { trackChatToolActivity } from './chatToolActivity'

// ── Chat `captureScreenshot`, in main ────────────────────────────────────────
//
// Capture was already main's (`screenshot:captureWindow`); what the renderer
// held was the user-bound window, which now rides on the turn request. The
// tool takes no arguments — it can only capture that one window.

export type CaptureScreenshotOutput = {
  ok: boolean
  message: string
  windowName?: string
  /** data:image/png;base64,… — the UI renders it and the engine injects it as vision. */
  dataUri?: string
}

const NO_WINDOW =
  'No window is selected for screen capture. Ask the user to pick a window in AI Playground ' +
  'settings (Built-in tools → Capture screenshot) before using this tool.'

export async function executeChatScreenshotTool(options: {
  target?: CaptureTarget
  conversationKey?: string
}): Promise<CaptureScreenshotOutput> {
  const target = options.target
  if (!target) return { ok: false, message: NO_WINDOW }
  return await trackChatToolActivity(
    { category: 'tools', label: 'Capturing screenshot…', conversationKey: options.conversationKey },
    async () => {
      try {
        const dataUri = await captureWindow(target)
        return {
          ok: true,
          message: `Captured a screenshot of "${target.name}".`,
          windowName: target.name,
          dataUri,
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  )
}
