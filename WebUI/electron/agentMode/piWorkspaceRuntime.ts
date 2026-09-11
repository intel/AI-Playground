import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { appLoggerInstance } from '../logging/logger.ts'
import { closeBrowserSession } from '../subprocesses/agentBrowser.ts'
import { injectProbe, PROBE_PATH, PROBE_SCRIPT } from './previewProbe.ts'

// ── Workspace runtime: localhost preview server ──────────────────────────────
//
// Pi's file tools work on workspace paths, but a browser needs a URL. Bridging
// those two worlds by hand (guessing an absolute file:// path) is exactly where
// mid-size models flail, and file:// pages hit cross-origin restrictions. So the
// workspace is served over a loopback HTTP server and the session instructions
// tell the model to preview/debug through that base URL. `Cache-Control:
// no-store` means a reload after an edit always shows the new version.
//
// The runtime is keyed by session id and outlives individual turns, so the
// preview port stays stable for a whole conversation.
//
// Pages served here also carry the play-test probe (previewProbe.ts), grafted in
// on the way out. It exists only in this preview: the file on disk — the one the
// user plays and shares — is untouched.

const logger = appLoggerInstance
const LOG_SOURCE = 'piWorkspaceRuntime'

const WORKSPACE_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.glb': 'model/gltf-binary',
}

function isHtml(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase()
  return extension === '.html' || extension === '.htm'
}

/** Serve an in-memory body, honouring HEAD the same way a file response does. */
function sendBuffer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
  contentType: string,
): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

export type WorkspaceRuntime = {
  sessionId: string
  workspaceDir: string
  server: http.Server | null
  baseUrl: string | null
}

let workspaceRuntime: WorkspaceRuntime | null = null

/**
 * Start a read-only static file server bound to 127.0.0.1 on an ephemeral port,
 * serving files under `root` (containment-checked; directories fall back to
 * index.html). Localhost-only, GET/HEAD only, no caching — a dev preview
 * surface for the agent, not a public server.
 */
function startWorkspaceServer(root: string): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end('Method Not Allowed')
        return
      }
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      // Answered before anything touches the workspace, so a file of the same
      // name in the game folder cannot shadow the probe the agent tests with.
      if (urlPath === PROBE_PATH) {
        sendBuffer(req, res, Buffer.from(PROBE_SCRIPT, 'utf-8'), WORKSPACE_CONTENT_TYPES['.js'])
        return
      }
      let fullPath = path.resolve(root, '.' + urlPath)
      const relative = path.relative(root, fullPath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(fullPath)
      } catch {
        // The browser asks for this on its own, and a 404 would be logged as a
        // console error the agent then tries to fix in a game that is fine.
        if (urlPath === '/favicon.ico') {
          res.writeHead(204)
          res.end()
          return
        }
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      if (stat.isDirectory()) {
        fullPath = path.join(fullPath, 'index.html')
        try {
          stat = fs.statSync(fullPath)
        } catch {
          res.writeHead(404)
          res.end('Not Found')
          return
        }
      }
      const contentType =
        WORKSPACE_CONTENT_TYPES[path.extname(fullPath).toLowerCase()] ?? 'application/octet-stream'
      // A page gets the probe grafted in, which changes its length — so it is
      // buffered instead of streamed. Games are a few tens of kilobytes; every
      // other kind of file keeps streaming.
      if (isHtml(fullPath)) {
        let page: string
        try {
          page = fs.readFileSync(fullPath, 'utf-8')
        } catch (error) {
          logger.warn(`preview server cannot read ${fullPath}: ${error}`, LOG_SOURCE)
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`Cannot read ${path.basename(fullPath)}`)
          return
        }
        sendBuffer(req, res, Buffer.from(injectProbe(page), 'utf-8'), contentType)
        return
      }
      const headers = {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, headers)
        res.end()
        return
      }
      // A successful stat does not mean the read will succeed — macOS hands out
      // metadata for a protected folder while refusing its contents (EPERM), and
      // a file can vanish between the two calls. `pipe()` does not forward
      // stream errors, and an unhandled one on a file stream takes down the main
      // process, so the response waits for the file to actually open.
      const stream = fs.createReadStream(fullPath)
      stream.once('open', () => {
        res.writeHead(200, headers)
        stream.pipe(res)
      })
      stream.once('error', (error: NodeJS.ErrnoException) => {
        logger.warn(`preview server cannot read ${fullPath}: ${error}`, LOG_SOURCE)
        stream.destroy()
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`Cannot read ${path.basename(fullPath)} (${error.code ?? 'read failed'})`)
      })
      // Client gone (reload, navigation) — release the descriptor.
      res.once('close', () => stream.destroy())
    } catch {
      res.writeHead(500)
      res.end('Internal Server Error')
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/` })
    })
  })
}

export async function ensureWorkspaceRuntime(
  sessionId: string,
  workspaceDir: string,
): Promise<WorkspaceRuntime> {
  if (
    workspaceRuntime &&
    workspaceRuntime.sessionId === sessionId &&
    workspaceRuntime.workspaceDir === workspaceDir
  ) {
    return workspaceRuntime
  }
  closeWorkspaceRuntime()
  let server: http.Server | null = null
  let baseUrl: string | null = null
  try {
    const started = await startWorkspaceServer(workspaceDir)
    server = started.server
    baseUrl = started.baseUrl
    logger.info(`workspace served at ${baseUrl} (root ${workspaceDir})`, LOG_SOURCE)
  } catch (error) {
    logger.warn(`failed to start workspace server: ${error}`, LOG_SOURCE)
  }
  workspaceRuntime = { sessionId, workspaceDir, server, baseUrl }
  return workspaceRuntime
}

export function closeWorkspaceRuntime(): void {
  if (!workspaceRuntime) return
  closeBrowserSession(workspaceRuntime.sessionId)
  workspaceRuntime.server?.close()
  workspaceRuntime = null
}

/** Origin of the live workspace preview server, when it is up. */
function previewBaseUrl(): string | null {
  return workspaceRuntime?.baseUrl ?? null
}

/** A bare workspace path ("index.html") becomes a preview-server URL. */
export function resolvePreviewUrl(url: string | undefined): string | undefined {
  const base = previewBaseUrl()
  if (!url || !base || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url
  try {
    return new URL(url.replace(/^\/+/, ''), base).toString()
  } catch {
    return url
  }
}

export type WorkspaceInstructionsOptions = {
  /** Pi's working directory — the sandbox mount point or the real folder. */
  cwd: string
  /** Real host folder the user sees, for orientation. */
  workspaceDir: string
  baseUrl: string | null
  /** Whether the shell is the real host shell rather than the emulated one. */
  unsandboxed: boolean
  /**
   * Whether the emulated shell's `python3` works. Defaults to the host's
   * answer; an explicit value is for tests.
   */
  emulatedPython?: boolean
}

/**
 * The emulated shell's `python3` runs against a mount of the virtual
 * filesystem that just-bash fails to set up on Windows: every invocation dies
 * on startup with `PermissionError: '/host/workspace'`, before the script runs.
 * Offering it there would only cost the model turns it cannot recover, so the
 * prompt keeps quiet about it. Everything else in the emulated shell works.
 */
function hasEmulatedPython(): boolean {
  return process.platform !== 'win32'
}

/**
 * The facts Pi would otherwise have to guess: where its working directory is on
 * the host, what its shell can actually do, and the localhost URL its files are
 * served at. Appended to Pi's system prompt at session construction, so it is
 * re-asserted with the live preview port whenever the session is rebuilt.
 */
export function buildWorkspaceInstructions(options: WorkspaceInstructionsOptions): string {
  const { cwd, workspaceDir, baseUrl, unsandboxed } = options
  const python = options.emulatedPython ?? hasEmulatedPython()
  const lines = ['You are working inside a project workspace.']
  lines.push(
    unsandboxed
      ? `- Your working directory is ${workspaceDir} on the host — the folder the user sees.`
      : `- Your working directory is ${cwd}; it maps to ${workspaceDir} on the host, which is` +
          ' where the user sees the files.',
    '- Your file tools (read, edit, write, ls, grep, find, bash) operate RELATIVE to this' +
      ' workspace. Prefer workspace-relative paths like "index.html" or "src/app.js"; writes' +
      ' outside the workspace are rejected.',
  )
  lines.push(
    unsandboxed
      ? '- Your bash tool is a real shell in that folder: node, npm/npx, python3, git and curl' +
          ' work, and network access is live. You may install dependencies and run builds or' +
          ' test suites. Prefer short, non-interactive commands.'
      : '- Your bash tool is an emulated shell with the usual file/text utilities' +
          `${python ? ', python3' : ''} and a JavaScript interpreter (\`js-exec -c "…"\`, not` +
          ' `node`) for scripting. It has no network and no node/npm, so you cannot install' +
          ' packages, and you never need to start a web server — one is already running (see' +
          ' below).',
  )
  if (!unsandboxed) {
    lines.push(
      '- Nothing in that shell reaches the internet: there is no curl or wget. Read web pages' +
        ' with the browser tool instead.',
    )
    if (!python) {
      lines.push(
        '- There is no python3 in this shell. Script with `js-exec` instead, or do the work with' +
          ' the file tools.',
      )
    }
  }
  if (baseUrl) {
    lines.push(
      `- A local static web server already serves this workspace at: ${baseUrl}`,
      '- To view or debug a web page you created, open it with the browser tool — pass just the' +
        ` file name ("index.html") and it resolves against that server, or the full URL` +
        ` ${baseUrl}index.html — NOT a file:// path (file:// URLs hit cross-origin/loading` +
        ' restrictions). After editing a file, reload the same page; the server sends no-cache' +
        ' headers so you always see the latest version.',
      '- Typical web debug loop: open the page with the browser tool, read the console messages' +
        ' to find the error, edit the workspace file to fix it, reload the same URL, and re-check' +
        ' the console until it is clean.',
    )
  }
  return lines.join('\n')
}
