import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

// Agent browser windows are hidden but alive, and Electron withholds
// `window-all-closed` until every window is destroyed. A survivor therefore
// keeps the whole app (and its backends) running after the user closes the main
// window, so shutdown has to sweep sessions it holds no runtime for.

const created: FakeBrowserWindow[] = []

class FakeBrowserWindow {
  destroyed = false
  webContents = {
    executeJavaScript: vi.fn(async () => ''),
    setAudioMuted: vi.fn(),
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn(),
      sendCommand: vi.fn(),
    },
    on: vi.fn(),
    off: vi.fn(),
    getTitle: () => 'page',
  }
  isDestroyed = () => this.destroyed
  loadURL = vi.fn(async () => {})
  destroy = vi.fn(() => {
    this.destroyed = true
  })

  constructor() {
    created.push(this)
  }
}

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
  BrowserWindow: FakeBrowserWindow,
}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { closeAllBrowserSessions, closeBrowserSession, runBrowserAction } =
  await import('../../subprocesses/agentBrowser.ts')

/** Materialize a session's window without navigating anywhere. */
const openSession = (sessionId: string) =>
  runBrowserAction(sessionId, '/workspace', { action: 'console' })

describe('agent browser session teardown', () => {
  beforeEach(() => {
    closeAllBrowserSessions()
    created.length = 0
  })

  it('closes every session, including ones no runtime points at', async () => {
    await openSession('game-1')
    await openSession('game-2')
    expect(created).toHaveLength(2)

    closeAllBrowserSessions()

    expect(created.map((win) => win.destroyed)).toEqual([true, true])
  })

  it('detaches the debugger before destroying the window', async () => {
    await openSession('game-1')
    const [win] = created

    closeAllBrowserSessions()

    expect(win.webContents.debugger.detach).toHaveBeenCalled()
  })

  it('reopens a fresh window after teardown', async () => {
    await openSession('game-1')
    closeAllBrowserSessions()
    await openSession('game-1')

    expect(created).toHaveLength(2)
    expect(created[1].destroyed).toBe(false)
  })

  it('is a no-op with nothing open', () => {
    expect(() => closeAllBrowserSessions()).not.toThrow()
  })

  it('leaves other sessions alone when closing one', async () => {
    await openSession('game-1')
    await openSession('game-2')

    closeBrowserSession('game-1')

    expect(created[0].destroyed).toBe(true)
    expect(created[1].destroyed).toBe(false)
  })
})

describe('agent browser audio', () => {
  beforeEach(() => {
    closeAllBrowserSessions()
    created.length = 0
  })

  // The window is never shown, so a play-tested game's sound would reach the
  // user from nowhere and keep playing for the rest of the session.
  it('mutes the hidden window as soon as it is created', async () => {
    await openSession('game-1')

    expect(created[0].webContents.setAudioMuted).toHaveBeenCalledWith(true)
  })
})
