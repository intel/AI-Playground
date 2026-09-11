import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

// The `eval` action wraps the model's script so the page reports what actually
// went wrong. The fake BrowserWindow below really evaluates the wrapper (it is
// plain JS), so these tests cover the wrapping itself: which script forms work,
// and what a thrown error comes back as.

const executeJavaScript = vi.fn(async (code: string) => await eval(code))

class FakeBrowserWindow {
  webContents = {
    executeJavaScript,
    setAudioMuted: vi.fn(),
    debugger: {
      attach: () => {
        throw new Error('no debugger in tests')
      },
      on: vi.fn(),
      sendCommand: vi.fn(),
    },
    on: vi.fn(),
    off: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  }
  isDestroyed = () => false
  loadURL = vi.fn(async () => {})
  destroy = vi.fn()
}

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
  BrowserWindow: FakeBrowserWindow,
}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { runBrowserAction } = await import('../../subprocesses/agentBrowser.ts')

async function evaluate(script: string) {
  return runBrowserAction('session-1', '/workspace', { action: 'eval', script })
}

describe("browser 'eval'", () => {
  beforeEach(() => {
    executeJavaScript.mockClear()
  })

  it('returns the value of an expression', async () => {
    expect(await evaluate('1 + 1')).toEqual({ text: '2' })
    expect(await evaluate('"ready"')).toEqual({ text: 'ready' })
  })

  // Models write both forms; a bare `return` is not a valid expression, so the
  // unwrapped script used to fail to compile at all.
  it('runs a statement list with a top-level return', async () => {
    expect(await evaluate('const a = 2; const b = 3; return a * b')).toEqual({ text: '6' })
  })

  it('reports what the script threw, not that something did', async () => {
    await expect(evaluate('move(-1, 0)')).rejects.toThrow(/move is not defined/)
  })

  it('survives a result that cannot leave the page', async () => {
    const circular = 'const a = {}; a.self = a; return a'
    expect((await evaluate(circular)).text).toContain('object')
  })
})
