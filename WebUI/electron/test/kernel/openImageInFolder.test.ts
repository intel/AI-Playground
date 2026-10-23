import { afterEach, describe, expect, it, vi } from 'vitest'

// A renderer-supplied aipg-media URL is percent-decoded before this handler
// sees it. The decoded path can contain `"` and `&`, which cmd.exe treats as
// syntax when they are interpolated into an `exec` string. The path must stay
// one argv element.

const child = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}))
const shellApi = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
  openPath: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, exec: child.exec, execFile: child.execFile }
})

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-test' },
  shell: shellApi,
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeImage: {},
  BrowserWindow: class {},
  dialog: {},
  net: {},
  screen: {},
}))

const { buildCoreSendRegistry } = await import('../../kernel/registries/core')

const injectedPath = String.raw`C:\AI Playground\games\x"&calc /proof`

function registry() {
  return buildCoreSendRegistry({
    getWin: () => undefined,
    getServiceRegistry: () => null,
    appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    mediaDir: String.raw`C:\AI Playground\media`,
    getLocalPathFromAipgMediaUrl: () => injectedPath,
    externalRes: '',
    handleChatTelemetryEvent: vi.fn() as never,
    setVerboseAgentLogging: vi.fn() as never,
  })
}

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  child.exec.mockClear()
  child.execFile.mockClear()
  shellApi.showItemInFolder.mockClear()
  setPlatform(realPlatform)
})

describe('openImageInFolder', () => {
  it('passes a path containing a quote and an ampersand as an explorer argument on Windows', () => {
    setPlatform('win32')

    registry().openImageInFolder({} as never, 'aipg-media://games/x%22%26calc%20/proof')

    expect(child.execFile).toHaveBeenCalledTimes(1)
    expect(child.execFile).toHaveBeenCalledWith('explorer.exe', ['/select,', injectedPath])
    expect(child.exec).not.toHaveBeenCalled()
    expect(shellApi.showItemInFolder).not.toHaveBeenCalled()
  })

  it('reveals the same path through the shell API off Windows', () => {
    setPlatform('linux')

    registry().openImageInFolder({} as never, 'aipg-media://games/x%22%26calc%20/proof')

    expect(shellApi.showItemInFolder).toHaveBeenCalledTimes(1)
    expect(shellApi.showItemInFolder).toHaveBeenCalledWith(injectedPath)
    expect(child.exec).not.toHaveBeenCalled()
    expect(child.execFile).not.toHaveBeenCalled()
  })

  it('does nothing when the URL does not resolve to a file', () => {
    setPlatform('win32')
    const handlers = buildCoreSendRegistry({
      getWin: () => undefined,
      getServiceRegistry: () => null,
      appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      mediaDir: String.raw`C:\AI Playground\media`,
      getLocalPathFromAipgMediaUrl: () => null,
      externalRes: '',
      handleChatTelemetryEvent: vi.fn() as never,
      setVerboseAgentLogging: vi.fn() as never,
    })

    handlers.openImageInFolder({} as never, 'aipg-media://games/missing')

    expect(child.exec).not.toHaveBeenCalled()
    expect(child.execFile).not.toHaveBeenCalled()
    expect(shellApi.showItemInFolder).not.toHaveBeenCalled()
  })
})
