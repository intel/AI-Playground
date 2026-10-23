/**
 * Main-side transport client for the ComfyUI backend
 * (docs/architecture-target.md §4.1, step 5).
 *
 * Faithful port of the renderer engine's `comfyFetch` + websocket surface
 * (`src/assets/js/store/comfyUiPresets.ts`): the loopback bearer token
 * (minted per spawn by the service, required by the bundled `aipg-auth`
 * middleware on everything but /queue), one websocket shared across runs,
 * token-in-query-string on the /ws upgrade (main's WebSocket client cannot
 * set headers either). No run logic lives here — the artifact runner decides
 * what a message means for the active run.
 */
import { appLoggerInstance } from '../observability/logger'

const appLogger = appLoggerInstance

const WEBSOCKET_OPEN = 1
const WEBSOCKET_CONNECTING = 0

export type ComfyClientDeps = {
  /** `http://127.0.0.1:<port>` of the running ComfyUI service, or null. */
  getServiceBaseUrl(): string | null
  /**
   * Live loopback token, read from the service instance per call — each spawn
   * regenerates `AIPG_LOOPBACK_TOKEN`, so a cached token would go stale exactly
   * when the backend restarts mid-run.
   */
  getToken(): string
}

/** fetch() with the loopback bearer token and a single 401 retry on a fresh token. */
export async function comfyFetch(
  baseUrl: string,
  deps: ComfyClientDeps,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const buildInit = (token: string): RequestInit => {
    const headers = new Headers(init.headers ?? {})
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return { ...init, headers }
  }
  let token = deps.getToken()
  let response = await fetch(`${baseUrl}${path}`, buildInit(token))
  if (response.status === 401) {
    token = deps.getToken()
    if (token) response = await fetch(`${baseUrl}${path}`, buildInit(token))
  }
  return response
}

/** POST /prompt — one queued workflow per batch entry. */
export async function submitPrompt(
  baseUrl: string,
  deps: ComfyClientDeps,
  workflow: unknown,
  clientId: string,
): Promise<void> {
  const result = await comfyFetch(baseUrl, deps, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  })
  if (result.status > 299) {
    throw new Error(`ComfyUI Backend responded with ${result.status}: ${await result.text()}`)
  }
}

/** POST /interrupt — stop the executing prompt (best-effort). */
export async function interruptExecution(baseUrl: string, deps: ComfyClientDeps): Promise<void> {
  await comfyFetch(baseUrl, deps, '/interrupt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
}

/** POST /queue {clear: true} — drop everything still queued (best-effort). */
export async function clearQueue(baseUrl: string, deps: ComfyClientDeps): Promise<void> {
  await comfyFetch(baseUrl, deps, '/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear: true }),
  })
}

/** POST /free — free memory and unload models (the "Keep models loaded" path). */
export async function freeMemoryAndUnloadModels(
  baseUrl: string,
  deps: ComfyClientDeps,
): Promise<void> {
  await comfyFetch(baseUrl, deps, '/free', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ free_memory: true, unload_models: true }),
  })
}

/**
 * Uploads one input file into ComfyUI's input directory (same endpoint for
 * images and videos — `LoadImage`/`VHSLoadVideo` both read from there).
 */
export async function uploadInputFile(
  baseUrl: string,
  deps: ComfyClientDeps,
  file: { name: string; blob: Blob; subfolder?: string },
): Promise<void> {
  const body = new FormData()
  body.append('image', file.blob, file.name)
  body.append('overwrite', 'true')
  if (file.subfolder) body.append('subfolder', file.subfolder)
  const result = await comfyFetch(baseUrl, deps, '/upload/image', { method: 'POST', body })
  if (result.status > 299) {
    throw new Error(`Uploading input file ${file.name} failed with ${result.status}`)
  }
}

export type ComfySocketHandlers = {
  /** Decoded binary preview frame (the 4-byte type prefix is already stripped). */
  onBinaryPreview: (mime: string, bytes: ArrayBuffer) => void
  /** Parsed JSON status message. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onJson: (msg: any) => void
  /** The shared socket closed (clean or not); the runner decides what to fail. */
  onClose: (code: number, reason: string) => void
}

export type ComfySocketHandle = {
  /** Resolves once the upgrade succeeded; rejects on error/close before open. */
  opened: Promise<void>
  readyState(): number
  /** Replaces the handlers the shared socket forwards to (new run, new handlers). */
  setHandlers(handlers: ComfySocketHandlers): void
  close(): void
}

// One socket per baseUrl, shared across runs like the renderer store's — the
// backend is single-user and one connection is one progress stream.
const sockets = new Map<string, ComfySocketHandle>()
let activeHandlers: ComfySocketHandlers | null = null

export function getComfySocket(
  baseUrl: string,
  deps: ComfyClientDeps,
  clientId: string,
  handlers: ComfySocketHandlers,
): ComfySocketHandle {
  const existing = sockets.get(baseUrl)
  if (
    existing &&
    (existing.readyState() === WEBSOCKET_OPEN || existing.readyState() === WEBSOCKET_CONNECTING)
  ) {
    appLogger.info('ComfyUI websocket already connected or connecting, reusing', 'electron-backend')
    existing.setHandlers(handlers)
    return existing
  }
  if (existing) {
    try {
      existing.close()
    } catch (e) {
      appLogger.warn(`Error closing stale ComfyUI websocket: ${e}`, 'electron-backend')
    }
    sockets.delete(baseUrl)
  }

  // The /ws upgrade cannot carry an Authorization header from main's WHATWG
  // WebSocket any more than from a browser, so the bundled aipg-auth
  // middleware accepts the token via query string for this endpoint only.
  // The token is read fresh per connect: a rejected upgrade surfaces as a bare
  // close with no auth status code, so retry-on-401 is impossible here.
  const token = deps.getToken()
  const wsUrl =
    `ws://127.0.0.1:${new URL(baseUrl).port}/ws?clientId=${clientId}` +
    (token ? `&token=${encodeURIComponent(token)}` : '')

  let openedResolve: (() => void) | null = null
  let openedReject: ((reason: Error) => void) | null = null
  const socket = new WebSocket(wsUrl)
  socket.binaryType = 'arraybuffer'

  const dispatch = (fn: (h: ComfySocketHandlers) => void) => {
    if (activeHandlers) fn(activeHandlers)
  }

  socket.addEventListener('open', () => {
    appLogger.info('ComfyUI websocket connection established', 'electron-backend')
    openedResolve?.()
  })
  socket.addEventListener('close', (event) => {
    appLogger.info(
      `ComfyUI websocket connection closed: ${event.code}${event.reason ? ` (${event.reason})` : ''}`,
      'electron-backend',
    )
    if (sockets.get(baseUrl) === handle) sockets.delete(baseUrl)
    dispatch((h) => h.onClose(event.code, event.reason))
    openedReject?.(new Error(`ComfyUI websocket closed before opening (code ${event.code})`))
  })
  socket.addEventListener('error', () => {
    appLogger.error('ComfyUI websocket error', 'electron-backend')
  })
  socket.addEventListener('message', (event) => {
    try {
      if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data)
        const eventType = view.getUint32(0)
        if (eventType !== 1) return // 1 = PREVIEW_IMAGE; others are unused by the UI
        const imageType = view.getUint32(4)
        const mime = imageType === 2 ? 'image/png' : 'image/jpeg'
        dispatch((h) => h.onBinaryPreview(mime, event.data.slice(8)))
        return
      }
      dispatch((h) => h.onJson(JSON.parse(event.data)))
    } catch (error) {
      appLogger.warn(`Unhandled ComfyUI websocket message: ${error}`, 'electron-backend')
    }
  })

  const opened = new Promise<void>((resolve, reject) => {
    openedResolve = resolve
    openedReject = reject
  })
  // A close before the upgrade resolves for nobody (the runner only awaits when
  // it is about to submit) — without this branch the rejection would be
  // unhandled and crash the process.
  opened.catch(() => {})

  const handle: ComfySocketHandle = {
    opened,
    readyState: () => socket.readyState,
    setHandlers(next: ComfySocketHandlers) {
      activeHandlers = next
    },
    close() {
      try {
        socket.close()
      } catch (e) {
        appLogger.warn(`Error closing ComfyUI websocket: ${e}`, 'electron-backend')
      }
    },
  }
  handle.setHandlers(handlers)
  sockets.set(baseUrl, handle)
  return handle
}

/**
 * Drops the shared socket for `baseUrl` so the next run opens a fresh one.
 * Called from the runner when a run settles, before a queued run starts —
 * otherwise leftover `executed` frames of the previous prompt would land on
 * the next run's handlers (same client, same connection).
 */
export function releaseComfySocket(baseUrl: string): void {
  const existing = sockets.get(baseUrl)
  if (!existing) return
  sockets.delete(baseUrl)
  activeHandlers = null
  try {
    existing.close()
  } catch (error) {
    appLogger.warn(`Error closing ComfyUI websocket: ${error}`, 'electron-backend')
  }
}

/** Test seam: forget the shared sockets between unit tests. */
export function resetComfySocketsForTest(): void {
  for (const socket of sockets.values()) {
    try {
      socket.close()
    } catch {
      // already closing
    }
  }
  sockets.clear()
  activeHandlers = null
}
