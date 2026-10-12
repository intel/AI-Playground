import type { WebContents } from 'electron'
import type { CameraCaptureInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { isAcerVendorOverride } from '@/lib/acerVendorOverride'

export type CameraCaptureDeps = {
  oemVendorOverride: () => string | null | undefined
  isDirectRunning: () => Promise<boolean>
  logWarn: (message: string) => void
  registerShortcut: (sender: WebContents) => boolean
  unregisterShortcut: () => void
}

export function buildCameraCaptureRegistry(deps: CameraCaptureDeps) {
  return {
    'cameraCapture:isDirectRunning': async (_event) => {
      if (!isAcerVendorOverride(deps.oemVendorOverride())) return false
      try {
        return await deps.isDirectRunning()
      } catch (error) {
        deps.logWarn(`Unable to inspect Acer camera services: ${error}`)
        return false
      }
    },

    'cameraCapture:registerShortcut': (event) => deps.registerShortcut(event.sender),

    'cameraCapture:unregisterShortcut': () => {
      deps.unregisterShortcut()
    },
  } satisfies InvokeHandlerMap<CameraCaptureInvokeName>
}
