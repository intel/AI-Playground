import http from 'node:http'
import { net } from 'electron'
import { appLoggerInstance as appLogger } from './logging/logger.ts'

const SOURCE = 'cloud-proxy'

export type CloudProxy = {
  /** Loopback base URL the renderer points its OpenAI-compatible client at. */
  url: string
  close: () => void
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

/**
 * A tiny loopback HTTP proxy for Cloud Mode that runs the actual networking to
 * the remote OpenAI-compatible provider in the main (Node) process — analogous
 * to how the Home Agent proxies inference. The renderer only ever talks to this
 * loopback URL, so:
 *   - there is no CORS problem (loopback already gets permissive headers), and
 *   - all upstream failures are logged to the Node console via appLogger,
 *     instead of surfacing as opaque `TypeError: Failed to fetch` in the browser.
 *
 * Per-request the renderer sends:
 *   - `X-Cloud-Upstream`: the provider base URL (scheme://host[/...], `/v1`
 *     optional — it is normalized away here), and
 *   - `X-Cloud-Provider`: the provider id, used to look up the encrypted API
 *     key in the main process (the key never travels through the renderer).
 *
 * `getKey` resolves a provider's decrypted API key (or null) in the main process.
 */
export async function startCloudProxy(
  getKey: (providerId: string) => string | null,
): Promise<CloudProxy> {
  const server = http.createServer((req, res) => {
    // CORS preflight: the renderer's cross-port request carries custom headers
    // (X-Cloud-*), so the browser sends an OPTIONS preflight to this loopback
    // proxy. Answer it directly — the app's onHeadersReceived hook injects the
    // Access-Control-* headers on localhost responses (see main.ts).
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
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
        res.writeHead(502, { 'content-type': 'application/json' })
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
  return { url, close: () => server.close() }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  getKey: (providerId: string) => string | null,
  signal: AbortSignal,
): Promise<void> {
  const upstreamBase = header(req, 'x-cloud-upstream')?.trim()
  const providerId = header(req, 'x-cloud-provider')?.trim()
  if (!upstreamBase) {
    appLogger.error('request missing X-Cloud-Upstream header', SOURCE)
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing X-Cloud-Upstream header' }))
    return
  }

  // Normalize so `${base}${path}` yields exactly one `/v1` segment regardless of
  // whether the user pasted the base with or without a trailing `/v1`.
  const base = upstreamBase.replace(/\/+$/, '').replace(/\/v1$/, '')
  const targetUrl = `${base}${req.url ?? '/'}`

  // Buffer the request body (chat completions payloads are small).
  const body = await readBody(req)

  const headers = new Headers()
  const contentType = header(req, 'content-type')
  if (contentType) headers.set('content-type', contentType)
  const accept = header(req, 'accept')
  if (accept) headers.set('accept', accept)
  const key = providerId ? getKey(providerId) : null
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
