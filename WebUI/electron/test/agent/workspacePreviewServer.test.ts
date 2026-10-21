import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The workspace preview server serves the agent's files to the browser tool. It
// runs in the main process, so a read failure there is not a 500 — it is an
// uncaught exception and an Electron crash dialog. That happens for real on
// macOS: the privacy layer hands out metadata for a folder under ~/Documents
// while refusing to open the files inside it (EPERM).

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
  BrowserWindow: class {},
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../agent/agentBrowser.ts', () => ({
  closeBrowserSession: vi.fn(),
}))

const { ensureWorkspaceRuntime, closeWorkspaceRuntime, buildWorkspaceInstructions } =
  await import('../../agent/piWorkspaceRuntime.ts')

let workspace: string

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-preview-'))
})

afterEach(() => {
  closeWorkspaceRuntime()
})

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

async function serve(fileName: string): Promise<Response> {
  const runtime = await ensureWorkspaceRuntime('session-1', workspace)
  expect(runtime.baseUrl).toBeTruthy()
  return await fetch(new URL(fileName, runtime.baseUrl!))
}

describe('workspace preview server', () => {
  it('serves a workspace file', async () => {
    fs.writeFileSync(path.join(workspace, 'game.js'), 'console.log("hi")')

    const response = await serve('game.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    expect(await response.text()).toBe('console.log("hi")')
  })

  // The probe is what `browser {"action":"probe"}` calls, so a page served
  // without it cannot be play-tested.
  it('grafts the play-test probe into a page it serves', async () => {
    fs.writeFileSync(
      path.join(workspace, 'index.html'),
      '<html><head></head><body>hi</body></html>',
    )

    const response = await serve('index.html')
    const page = await response.text()

    expect(page).toContain('<script src="/__aipg-probe.js"></script>')
    expect(page).toContain('<body>hi</body>')
    // Injection lengthens the body, so a streamed file's size would be a lie
    // and the browser would truncate the page.
    expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(page))
  })

  it('leaves everything that is not a page alone', async () => {
    fs.writeFileSync(path.join(workspace, 'data.json'), '{"probe":false}')

    expect(await (await serve('data.json')).text()).toBe('{"probe":false}')
  })

  // The browser asks for it whether or not the game has one, and the agent reads
  // a failed request back as an error in its own page.
  it('does not turn the browser asking for a favicon into a page error', async () => {
    expect((await serve('favicon.ico')).status).toBe(204)
  })

  it('serves the probe itself, where no workspace file can shadow it', async () => {
    fs.writeFileSync(path.join(workspace, '__aipg-probe.js'), 'window.__aipgProbe = "hijacked"')

    const response = await serve('__aipg-probe.js')
    const script = await response.text()

    expect(response.headers.get('content-type')).toContain('javascript')
    expect(script).not.toContain('hijacked')
    expect(script).toContain('window.__aipgProbe')
  })

  // Windows ignores a chmod of the read bit, so the file stays readable and
  // there is no failure to answer with.
  it.skipIf(process.platform === 'win32')(
    'answers with an error instead of crashing when the file cannot be opened',
    async () => {
      const unreadable = path.join(workspace, 'locked.html')
      fs.writeFileSync(unreadable, '<h1>secret</h1>')
      fs.chmodSync(unreadable, 0o000)

      const response = await serve('locked.html')

      expect(response.status).toBe(500)
      expect(await response.text()).toContain('locked.html')
    },
  )
})

describe('workspace instructions', () => {
  const options = {
    cwd: '/workspace',
    workspaceDir: 'C:\\games\\space',
    baseUrl: 'http://127.0.0.1:45678/',
    unsandboxed: false,
  }

  it('tells the model the emulated shell has no script interpreter', () => {
    const instructions = buildWorkspaceInstructions(options)

    expect(instructions).toContain('no script interpreter (no python3, node or js-exec)')
    expect(instructions).not.toContain('js-exec -c')
  })

  it('still offers the real interpreters in host-shell mode', () => {
    const instructions = buildWorkspaceInstructions({ ...options, unsandboxed: true })

    expect(instructions).toContain('python3')
    expect(instructions).not.toContain('no script interpreter')
  })
})
