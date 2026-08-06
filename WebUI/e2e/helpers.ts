import { type ElectronApplication, type Page } from '@playwright/test'

/**
 * Return the main renderer window among Electron's windows. The first window may
 * briefly be `about:blank` (or a DevTools window); the real app window loads from
 * the Vite dev server, so we wait for a window whose URL points at 127.0.0.1.
 */
export async function getMainWindow(electronApp: ElectronApplication): Promise<Page> {
  const start = Date.now()
  const TIMEOUT = 30_000

  while (Date.now() - start < TIMEOUT) {
    for (const w of electronApp.windows()) {
      const url = w.url()
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return w
      }
    }

    const windows = electronApp.windows()
    if (windows.length === 1 && windows[0].url() === 'about:blank') {
      try {
        await windows[0].waitForURL(/http:\/\/127\.0\.0\.1/, { timeout: 5_000 })
        return windows[0]
      } catch {
        // keep polling
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  const windows = electronApp.windows()
  if (windows.length > 0) return windows[0]
  throw new Error('No Electron windows appeared within 30s')
}
