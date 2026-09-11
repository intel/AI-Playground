import { BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { appLoggerInstance } from '../logging/logger.ts'
import { formatProbeReport, PROBE_CALL, type ProbeReport } from '../agentMode/previewProbe.ts'

// ── Agent browser (Electron-native) ──────────────────────────────────────────
//
// A headless preview/debug browser for Agent Mode that reuses ELECTRON'S OWN
// bundled Chromium — no Playwright, no separate browser download, no extra
// packaging. One hidden BrowserWindow per agent session; the Chrome DevTools
// Protocol (exposed on every webContents via `webContents.debugger`) captures
// console output AND uncaught exceptions with full fidelity — the same protocol
// the Chrome DevTools MCP speaks, but on the bundled engine and behind a single
// small tool instead of 29 MCP schemas.

const logger = appLoggerInstance
const LOG_SOURCE = 'agentBrowser'

type BrowserSession = {
  win: BrowserWindow
  /** Console messages + uncaught exceptions captured since the last `open`. */
  logs: string[]
  attached: boolean
}

const sessions = new Map<string, BrowserSession>()

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Best-effort flattening of a CDP Runtime.RemoteObject into a log string. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatRemoteObject(arg: any): string {
  if (arg == null) return ''
  if (arg.value !== undefined) {
    return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value)
  }
  return arg.description ?? arg.unserializableValue ?? arg.type ?? ''
}

function ensureBrowserSession(sessionId: string): BrowserSession {
  const existing = sessions.get(sessionId)
  if (existing && !existing.win.isDestroyed()) return existing

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  // This window is never shown, so a game's sound would come from nowhere and
  // outlive the play-test that started it — the page stays loaded all session.
  win.webContents.setAudioMuted(true)
  const session: BrowserSession = { win, logs: [], attached: false }

  // Prefer the CDP debugger (captures console.* AND uncaught exceptions). Fall
  // back to the plain console-message event (console.* only) if attach fails.
  try {
    win.webContents.debugger.attach('1.3')
    session.attached = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    win.webContents.debugger.on('message', (_event, method: string, params: any) => {
      if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args ?? []).map(formatRemoteObject).join(' ')
        session.logs.push(`[${params.type}] ${text}`)
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails
        const message = details?.exception?.description ?? details?.text ?? 'Uncaught exception'
        session.logs.push(`[error] ${message}`)
      } else if (method === 'Log.entryAdded') {
        session.logs.push(`[${params.entry.level}] ${params.entry.text}`)
      }
    })
    void win.webContents.debugger.sendCommand('Runtime.enable')
    void win.webContents.debugger.sendCommand('Log.enable')
  } catch (error) {
    logger.warn(`CDP attach failed, falling back to console-message: ${error}`, LOG_SOURCE)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    win.webContents.on('console-message', (event: any) => {
      const level = event?.level ?? 'log'
      const message = event?.message ?? String(event ?? '')
      session.logs.push(`[${level}] ${message}`)
    })
  }

  sessions.set(sessionId, session)
  return session
}

/** Whether the script is a single expression (`document.title`) rather than statements. */
function parsesAsExpression(script: string): boolean {
  try {
    // Compiled as a syntax check only — never called, and never in the page.
    new Function(`return (\n${script}\n)`)
    return true
  } catch {
    return false
  }
}

/**
 * Run the script inside its own try/catch in the page, reporting what actually
 * went wrong. Electron rejects a throwing `executeJavaScript` with one fixed
 * sentence ("Script failed to execute … check the renderer console"), which is
 * useless to a model that cannot read that console: it just guesses another
 * script. The real message ("move is not defined") ends the guessing.
 *
 * Models write both forms — a bare expression and a statement list ending in
 * `return` — so the script goes into a function body, and an expression is
 * returned from it.
 */
function wrapForEval(script: string): string {
  const body = parsesAsExpression(script) ? `return (\n${script}\n)` : script
  return `(async () => {
    try {
      const value = await (async () => { ${body} })()
      // Stringified in the page: the result may be a DOM node or a cycle, which
      // could not cross the IPC boundary as-is.
      try {
        return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value) }
      } catch {
        return { ok: true, text: String(value) }
      }
    } catch (error) {
      return { ok: false, error: String((error && error.stack) || error) }
    }
  })()`
}

export type BrowserToolInput = {
  action: 'open' | 'console' | 'eval' | 'screenshot' | 'probe'
  url?: string
  script?: string
}

export type BrowserActionResult = {
  /** What the model is told. */
  text: string
  /** Workspace-relative path of a screenshot this action produced, for the UI. */
  screenshotPath?: string
}

/**
 * Execute one browser action for a session. Runs in the Electron main process
 * against a hidden BrowserWindow (bundled Chromium). Returns a plain string for
 * the model. Screenshots are saved into `<workspace>/generated/` and the tool
 * returns the workspace-relative PATH (never base64 — that overflows context).
 */
export async function runBrowserAction(
  sessionId: string,
  workspaceDir: string,
  input: BrowserToolInput,
): Promise<BrowserActionResult> {
  const session = ensureBrowserSession(sessionId)
  switch (input.action) {
    case 'open': {
      if (!input.url) throw new Error("browser 'open' requires a url")
      session.logs.length = 0
      // `loadURL` resolves for an error response just as it does for a page, so
      // without the navigation status a 404/500 looks like a successful open and
      // the model debugs a page the server never served.
      let status = 0
      let statusText = ''
      const onNavigate = (_event: unknown, _url: string, code: number, text: string) => {
        status = code
        statusText = text
      }
      session.win.webContents.on('did-navigate', onNavigate)
      try {
        await session.win.loadURL(input.url)
      } finally {
        session.win.webContents.off('did-navigate', onNavigate)
      }
      // Let late async console output / errors settle before returning.
      await delay(400)
      if (status >= 400) {
        const body = await session.win.webContents
          .executeJavaScript('document.body?.innerText ?? ""', true)
          .catch(() => '')
        const detail = String(body).trim().slice(0, 300)
        return {
          text:
            `Failed to open ${input.url}: HTTP ${status} ${statusText}.` +
            (detail ? ` The server said: ${detail}` : ''),
        }
      }
      const title = session.win.webContents.getTitle()
      // The error count rides along on the open: a model that forgets to ask for
      // the console otherwise debugs a page it never learned was throwing.
      const errors = session.logs.filter((line) => line.startsWith('[error]')).length
      const trouble =
        errors > 0
          ? ` ${errors} console error${errors === 1 ? '' : 's'} already — read them with the` +
            ' console action.'
          : ''
      return { text: `Opened ${input.url}${title ? ` (title: ${title})` : ''}.${trouble}` }
    }
    case 'console':
      return { text: session.logs.length > 0 ? session.logs.join('\n') : '<no console messages>' }
    case 'eval': {
      if (!input.script) throw new Error("browser 'eval' requires a script")
      const outcome = (await session.win.webContents.executeJavaScript(
        wrapForEval(input.script),
        true,
      )) as { ok: boolean; text?: string; error?: string }
      if (!outcome?.ok) {
        throw new Error(`The script threw: ${outcome?.error ?? 'unknown error'}`)
      }
      return { text: outcome.text ?? 'undefined' }
    }
    case 'probe': {
      const raw = (await session.win.webContents.executeJavaScript(
        wrapForEval(PROBE_CALL),
        true,
      )) as { ok: boolean; text?: string; error?: string }
      if (!raw?.ok) {
        throw new Error(`The probe failed to run: ${raw?.error ?? 'unknown error'}`)
      }
      let report: ProbeReport
      try {
        report = JSON.parse(raw.text ?? '{}') as ProbeReport
      } catch {
        return { text: `The probe returned something unreadable: ${raw.text ?? '(nothing)'}` }
      }
      return { text: formatProbeReport(report) }
    }
    case 'screenshot': {
      const image = await session.win.webContents.capturePage()
      const generatedDir = path.join(workspaceDir, 'generated')
      fs.mkdirSync(generatedDir, { recursive: true })
      const filename = `screenshot-${Date.now()}.png`
      fs.writeFileSync(path.join(generatedDir, filename), image.toPNG())
      const relativePath = path.posix.join('generated', filename)
      return { text: `Saved screenshot to ${relativePath}`, screenshotPath: relativePath }
    }
    default:
      throw new Error(`Unknown browser action: ${String((input as BrowserToolInput).action)}`)
  }
}

/** Tear down a session's browser window (called on agent session teardown). */
export function closeBrowserSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  try {
    if (!session.win.isDestroyed()) {
      if (session.attached) session.win.webContents.debugger.detach()
      session.win.destroy()
    }
  } catch (error) {
    logger.warn(`failed to close agent browser: ${error}`, LOG_SOURCE)
  }
}

/**
 * Tear down every session's browser window, whether or not a workspace runtime
 * still points at it.
 *
 * These windows are hidden but very much alive, and Electron only emits
 * `window-all-closed` once every window is destroyed. One survivor therefore
 * keeps the app running after the user closes the main window: the teardown
 * never runs, the backends stay up, and the single-instance lock stays held, so
 * the next launch is refused. Per-session cleanup alone cannot guarantee this —
 * a session whose runtime never started, or was replaced, is not reachable from
 * it — so app shutdown sweeps the whole map.
 */
export function closeAllBrowserSessions(): void {
  for (const sessionId of [...sessions.keys()]) closeBrowserSession(sessionId)
}
