import type {
  InvokeHandlerMap,
  ScreenshotInvokeName,
  ScreenshotSendName,
  SendHandlerMap,
} from '../ipcRegistries'
import type {
  captureWindow,
  getScreenCaptureStatus,
  listCaptureWindows,
  openScreenCaptureSettings,
} from '../../adapters/hardware/screenCapture'

/** The OS screen-capture probes and settings opener the screenshot handlers close over. */
export type ScreenshotDeps = {
  getScreenCaptureStatus: typeof getScreenCaptureStatus
  openScreenCaptureSettings: typeof openScreenCaptureSettings
  listCaptureWindows: typeof listCaptureWindows
  captureWindow: typeof captureWindow
}

export function buildScreenshotRegistry(deps: ScreenshotDeps) {
  // `listWindows` is only ever called from the settings UI so the user can
  // bind the screenshot tool to a single window; it is never exposed to the
  // LLM. The Chat tool captures in main (it ships the bound window on the
  // turn); this channel serves the settings picker.
  return {
    'screenshot:getPermissionStatus': () => ({
      platform: process.platform,
      status: deps.getScreenCaptureStatus(),
    }),

    'screenshot:listWindows': async () => await deps.listCaptureWindows(),

    'screenshot:captureWindow': async (_event, target) => await deps.captureWindow(target),
  } satisfies InvokeHandlerMap<ScreenshotInvokeName>
}

export function buildScreenshotSendRegistry(deps: ScreenshotDeps) {
  return {
    'screenshot:openPermissionSettings': () => deps.openScreenCaptureSettings(),
  } satisfies SendHandlerMap<ScreenshotSendName>
}
