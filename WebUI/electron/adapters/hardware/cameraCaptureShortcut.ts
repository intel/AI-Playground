import { globalShortcut, type WebContents } from 'electron'
import { typedSend } from '../../kernel/typedIpc'

export const CAMERA_CAPTURE_ACCELERATOR = 'Alt+Shift+C'

export function registerCameraCaptureShortcut(sender: WebContents): boolean {
  unregisterCameraCaptureShortcut()
  return globalShortcut.register(CAMERA_CAPTURE_ACCELERATOR, () => {
    if (!sender.isDestroyed()) typedSend(sender, 'cameraCapture:shortcut', null)
  })
}

export function unregisterCameraCaptureShortcut(): void {
  globalShortcut.unregister(CAMERA_CAPTURE_ACCELERATOR)
}
