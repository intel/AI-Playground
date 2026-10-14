import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { net } from 'electron'
import { appLoggerInstance as appLogger } from '../observability/logger.ts'

const SOURCE = 'cloud-proxy'

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1'])

export type CloudProxy = {
  /** Loopback base URL the renderer points its OpenAI-compatible client at. */
  url: string
  /** Per-launch `X-AIPG-Auth` token. Stable until this proxy is closed. */
  authToken: string
  close: () => void
}

export type AllowedUpstream = {
  id: string
  baseUrl: string
}

// Headers that describe the transfer encoding of the upstream response. We
// re-chunk the body ourselves, so relaying these would make the browser try to
// decode an already-decoded stream (or trust a stale length) and fail.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
])

let activeAuthToken = ''
let allowedUpstreams = new Map<string, URL>()

/** Token of the running proxy, or '' before it has started. */
export function cloudProxyAuthToken(): string {
  return activeAuthToken
}

/**
 * Replace the provider-id → base-URL allowlist. Entries that are not http(s)
 * without userinfo are dropped, so a request for them fails closed.
 */
export function setAllowedUpstreams(entries: readonly AllowedUpstream[]): void {
  const next = new Map<string, URL>()
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.baseUrl !== 'string') continue
      const id = entry.id.trim()
      const base = canonicalBase(entry.baseUrl)
      if (!id || !base) continue
      next.set(id, base)
    }
  }
  allowedUpstreams = next
}

/**
 * A tiny loopback HTTP proxy for Cloud Mode that runs the actual networking to
 * the remote OpenAI-compatible provider in the main (Node) process — analogous
 * to how the Home Agent proxies inference. The renderer only ever talks to this
 * loopback URL, so:
 *   - there is no CORS problem (loopback already gets permissive headers), and
 *   - all upstream failures are logged to the Node console via appLogger,
 *     instead of surfacing as opaque `TypeError: Failed to fetch` in the browser.
 *
 * Per-request the caller sends:
 *   - `X-AIPG-Auth`: the per-launch token (required on every non-OPTIONS request),
 *   - `X-Cloud-Upstream`: the provider base URL, which must match the base
 *     registered for that provider (http/https only), and
 *   - `X-Cloud-Provider`: the provider id, used to look up the encrypted API key.
 *
 * `getKey` resolves a provider's decrypted API key (or null) in the main process.
 */
export async function startCloudProxy(
  getKey: (providerId: string) => string | null,
): Promise<CloudProxy> {
  const authToken = randomBytes(32).toString('hex')
  activeAuthToken = authToken

  const server = http.createServer((req, res) => {
    const peer = loopbackPeer(req.socket.remoteAddress)
    if (!peer) {
      reject(res, 403, 'loopback only')
      return
    }
    // CORS preflight: the browser strips custom headers, so OPTIONS cannot
    // carry the token. The real request that follows is authenticated.
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (!tokensMatch(header(req, 'x-aipg-auth') ?? '', authToken)) {
      reject(res, 401, 'unauthorized')
      return
    }

    // Abort the upstream request if the renderer disconnects (e.g. Stop). Listen
    // on the response stream so a mid-stream client disconnect tears down the
    // upstream fetch too; firing after a normal end is harmless.
    const abort = new AbortController()
    res.on('close', () => abort.abort())

    void handleRequest(req, res, getKey, abort.signal).catch((e) => {
      const detail = e instanceof Error ? (e.stack ?? e.message) : String(e)
      appLogger.error(`unhandled proxy error: ${detail}`, SOURCE)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json', connection: 'close' })
      }
      res.end(
        JSON.stringify({
          error: `Cloud proxy failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
      )
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const url = `http://127.0.0.1:${port}`
  appLogger.info(`listening on ${url}`, SOURCE)
  return {
    url,
    authToken,
    close: () => {
      if (activeAuthToken === authToken) activeAuthToken = ''
      server.close()
    },
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  getKey: (providerId: string) => string | null,
  signal: AbortSignal,
): Promise<void> {
  const providerId = header(req, 'x-cloud-provider')?.trim() ?? ''
  const allowed = providerId ? allowedUpstreams.get(providerId) : undefined
  const requested = canonicalBase(header(req, 'x-cloud-upstream') ?? '')
  if (!allowed || !requested || !sameBase(allowed, requested)) {
    appLogger.error(`rejected upstream for provider ${providerId || '(none)'}`, SOURCE)
    reject(res, 403, 'upstream not allowed')
    return
  }
  // Resolve the request path against the registered base. An absolute or
  // protocol-relative target would ignore that base (`new URL` prefers it),
  // and `../` can walk out of a path prefix — both are rejected.
  const target = targetFor(allowed, req.url)
  if (!target) {
    appLogger.error(`rejected request target for provider ${providerId}`, SOURCE)
    reject(res, 403, 'upstream not allowed')
    return
  }
  const targetUrl = target.toString()

  // Buffer the request body (chat completions payloads are small).
  const body = await readBody(req)

  const headers = new Headers()
  const contentType = header(req, 'content-type')
  if (contentType) headers.set('content-type', contentType)
  const accept = header(req, 'accept')
  if (accept) headers.set('accept', accept)
  const key = getKey(providerId)
  const authStyle = header(req, 'x-cloud-auth-style')?.trim() || 'bearer'
  if (key) applyAuth(headers, authStyle, key)

  const method = req.method ?? 'GET'
  appLogger.info(`${method} ${targetUrl} (auth=${key ? authStyle : 'no'})`, SOURCE)

  let upstream: Response
  try {
    upstream = await net.fetch(targetUrl, {
      method,
      headers,
      // Buffer is a Uint8Array at runtime but not in the BodyInit type; wrap it.
      body: (method === 'GET' || method === 'HEAD' ? undefined : body)
        ? new Uint8Array(body as Buffer)
        : undefined,
      signal,
      // `x-api-key` / `api-key` are forwarded across redirects; `Authorization`
      // is not. Refuse to follow so an allowed host cannot bounce the key.
      redirect: 'error',
    })
  } catch (e) {
    if (signal.aborted) {
      // Renderer cancelled — not a failure worth surfacing.
      res.destroy()
      return
    }
    const reason = e instanceof Error ? (e.stack ?? e.message) : String(e)
    appLogger.error(`${method} ${targetUrl} could not be reached: ${reason}`, SOURCE)
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: `Could not reach ${targetUrl}: ${e instanceof Error ? e.message : String(e)}`,
      }),
    )
    return
  }

  if (!upstream.ok) {
    // Read the body once for logging, then relay the same bytes downstream so
    // the renderer still sees the provider's own error payload.
    const errorText = await upstream
      .clone()
      .text()
      .catch(() => '')
    appLogger.error(
      `${method} ${targetUrl} -> ${upstream.status} ${upstream.statusText}: ${errorText.slice(0, 2000)}`,
      SOURCE,
    )
  }

  const responseHeaders: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value
  })
  res.writeHead(upstream.status, responseHeaders)

  if (upstream.body) {
    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) res.write(Buffer.from(value))
      }
    } catch (e) {
      // Mid-stream failure (upstream dropped, or renderer aborted). Log and end.
      if (!signal.aborted) {
        const reason = e instanceof Error ? e.message : String(e)
        appLogger.error(`${method} ${targetUrl} stream interrupted: ${reason}`, SOURCE)
      }
    } finally {
      reader.releaseLock()
    }
  }
  res.end()
}

function reject(res: http.ServerResponse, status: number, error: string): void {
  // Close so a body we did not read cannot desync a keep-alive connection.
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify({ error }))
}

function loopbackPeer(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return LOOPBACK_PEERS.has(normalized) || LOOPBACK_PEERS.has(address)
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Trim, drop one trailing `/v1`, and keep only an http(s) URL with no userinfo.
// String equality is not enough: `file:` and `https://user@host` must not match
// a configured provider host.
function canonicalBase(raw: string): URL | null {
  const trimmed = raw.trim()
  if (!trimmed || /[\s\\]/.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  if (parsed.search || parsed.hash) return null
  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  parsed.pathname = path === '' ? '/' : path
  return parsed
}

function sameBase(a: URL, b: URL): boolean {
  return (
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    a.port === b.port &&
    a.pathname === b.pathname
  )
}

function targetFor(base: URL, reqUrl: string | undefined): URL | null {
  const raw = reqUrl && reqUrl.length > 0 ? reqUrl : '/'
  const pathOnly = raw.split('?')[0] ?? raw
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
  if (pathOnly.includes('@')) return null
  const prefix = base.href.endsWith('/') ? base.href : `${base.href}/`
  let target: URL
  try {
    target = new URL(raw.slice(1), prefix)
  } catch {
    return null
  }
  if (target.username || target.password) return null
  if (
    target.protocol !== base.protocol ||
    target.hostname !== base.hostname ||
    target.port !== base.port
  ) {
    return null
  }
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
    return null
  }
  return target
}

// Attach the provider API key using its declared auth scheme. The request shape
// is OpenAI-compatible regardless; only the header differs. `bearer` is the
// default and covers every shipped preset; the variants cover surfaces whose
// key lives elsewhere (Anthropic `x-api-key`, Azure OpenAI `api-key`).
function applyAuth(headers: Headers, style: string, key: string): void {
  switch (style) {
    case 'x-api-key':
      headers.set('x-api-key', key)
      break
    case 'api-key':
      headers.set('api-key', key)
      break
    case 'bearer':
    default:
      headers.set('authorization', `Bearer ${key}`)
  }
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length ? Buffer.concat(chunks) : undefined
}
