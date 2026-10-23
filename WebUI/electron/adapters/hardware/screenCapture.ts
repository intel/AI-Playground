import { desktopCapturer, screen, shell, systemPreferences } from 'electron'

// Desktop window capture, shared by the `screenshot:*` IPC channels (the
// settings window picker) and the Chat `captureScreenshot` tool, which runs
// in main (docs/architecture-target.md §8).

export type ScreenCaptureStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export type CaptureTarget = { id: string; name: string }

export type CaptureWindowSource = CaptureTarget & { thumbnailDataUrl: string | null }

// macOS refuses screen capture without the Screen Recording permission, and
// `desktopCapturer.getSources` then either throws or returns a useless empty
// list — "Failed to get sources." — and crucially, once granted, the *running*
// app keeps failing until it is restarted. Convert both cases into an
// actionable message.
const SCREEN_PERMISSION_MESSAGE =
  'Screen Recording permission is required to capture windows. On macOS, open System ' +
  'Settings → Privacy & Security → Screen Recording, enable AI Playground (or Electron in ' +
  'development), then fully quit and restart the app — newly granted permission does not ' +
  'apply to the already-running process.'

export function getScreenCaptureStatus(): ScreenCaptureStatus {
  if (process.platform !== 'darwin') return 'granted'
  return systemPreferences.getMediaAccessStatus('screen')
}

async function getWindowSources(thumbnailSize: { width: number; height: number }) {
  if (getScreenCaptureStatus() !== 'granted') {
    throw new Error(SCREEN_PERMISSION_MESSAGE)
  }
  try {
    return await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize,
      fetchWindowIcons: false,
    })
  } catch (error) {
    // On macOS this is almost always the "granted but not yet restarted" case.
    if (process.platform === 'darwin') {
      throw new Error(SCREEN_PERMISSION_MESSAGE)
    }
    throw error
  }
}

export function openScreenCaptureSettings(): void {
  if (process.platform !== 'darwin') return
  void shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  )
}

export async function listCaptureWindows(): Promise<CaptureWindowSource[]> {
  const sources = await getWindowSources({ width: 320, height: 200 })
  return sources
    .filter((source) => source.name.trim().length > 0)
    .map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
    }))
}

export async function captureWindow(target: CaptureTarget): Promise<string> {
  if (!target || typeof target.id !== 'string') {
    throw new Error('captureWindow: invalid target window')
  }
  // Capture at the primary display's pixel resolution (capped) so the
  // screenshot is legible to a vision model rather than a tiny thumbnail.
  const display = screen.getPrimaryDisplay()
  const sources = await getWindowSources({
    width: Math.min(Math.round(display.size.width * display.scaleFactor), 2560),
    height: Math.min(Math.round(display.size.height * display.scaleFactor), 1600),
  })
  // Source ids are not stable across app restarts, so fall back to matching by
  // window title when the exact id is gone.
  const source =
    sources.find((s) => s.id === target.id) ?? sources.find((s) => s.name === target.name)
  if (!source) {
    throw new Error(
      `Window "${target.name}" is no longer available. Ask the user to re-select the window to capture.`,
    )
  }
  if (source.thumbnail.isEmpty()) {
    throw new Error(
      `Window "${target.name}" could not be captured (it may be minimized or hidden).`,
    )
  }
  return source.thumbnail.toDataURL()
}
