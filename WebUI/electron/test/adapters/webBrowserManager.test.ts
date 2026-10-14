import { beforeEach, describe, expect, it, vi } from 'vitest'

// The LLM drives this hidden window from chat text and RAG documents. Electron
// grants permission checks and requests on a session with no handler, so the
// persist:webbrowser partition has to deny them itself.

const sessionSpy = vi.hoisted(() => {
  const order: string[] = []
  const handlers = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
  }
  return {
    order,
    handlers,
    fromPartition: vi.fn((partition: string) => {
      order.push(`partition:${partition}`)
      return handlers
    }),
  }
})

const created: FakeBrowserWindow[] = []

class FakeBrowserWindow {
  destroyed = false
  options: { webPreferences?: { partition?: string } }
  webContents = {
    setUserAgent: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
  }

  constructor(options: { webPreferences?: { partition?: string } }) {
    this.options = options
    sessionSpy.order.push('window')
    created.push(this)
  }

  isDestroyed = () => this.destroyed
  isVisible = () => false
  setMenu = vi.fn()
  on = vi.fn()
  show = vi.fn()
  focus = vi.fn()
  hide = vi.fn()
  destroy = vi.fn(() => {
    this.destroyed = true
  })
}

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: FakeBrowserWindow,
  session: { fromPartition: sessionSpy.fromPartition },
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { close, show } = await import('../../adapters/webBrowserManager.ts')

describe('web browser session permissions', () => {
  beforeEach(() => {
    close()
    created.length = 0
    sessionSpy.order.length = 0
    sessionSpy.fromPartition.mockClear()
    sessionSpy.handlers.setPermissionRequestHandler.mockClear()
    sessionSpy.handlers.setPermissionCheckHandler.mockClear()
    sessionSpy.handlers.setDevicePermissionHandler.mockClear()
    sessionSpy.handlers.setDisplayMediaRequestHandler.mockClear()
  })

  it('locks the partition down before the window is created', () => {
    show()

    expect(sessionSpy.fromPartition).toHaveBeenCalledWith('persist:webbrowser')
    const partitionAt = sessionSpy.order.indexOf('partition:persist:webbrowser')
    const windowAt = sessionSpy.order.indexOf('window')
    expect(partitionAt).toBeGreaterThanOrEqual(0)
    expect(partitionAt).toBeLessThan(windowAt)
    expect(created).toHaveLength(1)
    expect(created[0].options.webPreferences?.partition).toBe('persist:webbrowser')
  })

  it('denies permission requests', () => {
    show()
    const request = sessionSpy.handlers.setPermissionRequestHandler.mock.calls[0][0] as (
      webContents: null,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void

    const media = vi.fn()
    const geo = vi.fn()
    request(null, 'media', media)
    request(null, 'geolocation', geo)

    expect(media).toHaveBeenCalledWith(false)
    expect(geo).toHaveBeenCalledWith(false)
  })

  it('denies permission checks for media, location, notifications, and clipboard', () => {
    show()
    const check = sessionSpy.handlers.setPermissionCheckHandler.mock.calls[0][0] as (
      webContents: null,
      permission: string,
      origin: string,
      details: { mediaType?: string },
    ) => boolean

    expect(check(null, 'media', 'https://evil.example', { mediaType: 'audio' })).toBe(false)
    expect(check(null, 'media', 'https://evil.example', { mediaType: 'video' })).toBe(false)
    expect(check(null, 'geolocation', 'https://evil.example', {})).toBe(false)
    expect(check(null, 'notifications', 'https://evil.example', {})).toBe(false)
    expect(check(null, 'clipboard-read', 'https://evil.example', {})).toBe(false)
  })

  it('denies device access and screen capture', () => {
    show()
    const device = sessionSpy.handlers.setDevicePermissionHandler.mock.calls[0][0] as (details: {
      deviceType: string
    }) => boolean
    const display = sessionSpy.handlers.setDisplayMediaRequestHandler.mock.calls[0][0] as (
      request: unknown,
      callback: (streams: Record<string, never>) => void,
    ) => void
    const streams = vi.fn()

    expect(device({ deviceType: 'usb' })).toBe(false)
    display({}, streams)
    expect(streams).toHaveBeenCalledWith({})
  })

  it('re-applies the lockdown when the window is reused', () => {
    show()
    show()

    expect(created).toHaveLength(1)
    expect(sessionSpy.fromPartition).toHaveBeenCalledTimes(2)
    expect(sessionSpy.handlers.setPermissionCheckHandler).toHaveBeenCalledTimes(2)
  })
})
