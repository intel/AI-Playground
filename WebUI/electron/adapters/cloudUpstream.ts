import { net } from 'electron'
import { appLoggerInstance as appLogger } from '../observability/logger.ts'

const SOURCE = 'cloud-upstream'

export type CloudUpstreamRequest = {
  providerId: string
  baseUrl: string
  authStyle: string
  /** Absolute provider URL, or a path resolved against `baseUrl`. */
  url: string
  init?: RequestInit
  getKey: (providerId: string) => string | null
}

let keyReader: (providerId: string) => string | null = () => null

/** Main registers the safeStorage reader once. Pi calls it at provider registration. */
export function setCloudProviderKeyReader(reader: (providerId: string) => string | null): void {
  keyReader = reader
}

export function cloudProviderKey(providerId: string): string | null {
  return keyReader(providerId)
}

/**
 * Fetch a cloud provider from main. The base must be http(s) with no userinfo,
 * and the request path cannot leave that origin. The stored key is attached here.
 */
export async function fetchCloudUpstream(request: CloudUpstreamRequest): Promise<Response> {
  const base = canonicalBase(request.baseUrl)
  const path = base ? requestPath(request.url, base) : null
  const target = base && path ? targetFor(base, path) : null
  if (!base || !target) {
    appLogger.error(`rejected upstream for provider ${request.providerId || '(none)'}`, SOURCE)
    throw new Error('upstream not allowed')
  }

  const headers = new Headers(request.init?.headers)
  headers.delete('authorization')
  headers.delete('x-api-key')
  headers.delete('api-key')
  const key = request.getKey(request.providerId)
  const authStyle = request.authStyle.trim() || 'bearer'
  if (key) applyAuth(headers, authStyle, key)

  const method = request.init?.method ?? 'GET'
  const targetUrl = target.toString()
  appLogger.info(`${method} ${targetUrl} (auth=${key ? authStyle : 'no'})`, SOURCE)

  let upstream: Response
  try {
    upstream = await net.fetch(targetUrl, {
      ...request.init,
      method,
      headers,
      // `x-api-key` / `api-key` follow redirects; `Authorization` does not.
      redirect: 'error',
    })
  } catch (e) {
    const reason = e instanceof Error ? (e.stack ?? e.message) : String(e)
    appLogger.error(`${method} ${targetUrl} could not be reached: ${reason}`, SOURCE)
    throw e
  }

  if (!upstream.ok) {
    appLogger.error(`${method} ${targetUrl} -> ${upstream.status} ${upstream.statusText}`, SOURCE)
  }
  return upstream
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

function requestPath(url: string, base: URL): string | null {
  const raw = url.trim()
  if (!raw) return '/'
  if (raw.startsWith('/')) return raw
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.username || parsed.password) return null
  if (
    parsed.protocol !== base.protocol ||
    parsed.hostname !== base.hostname ||
    parsed.port !== base.port
  ) {
    return null
  }
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')
  if (basePath && parsed.pathname !== basePath && !parsed.pathname.startsWith(`${basePath}/`)) {
    return null
  }
  return `${parsed.pathname}${parsed.search}`
}

function targetFor(base: URL, reqUrl: string): URL | null {
  const pathOnly = reqUrl.split('?')[0] ?? reqUrl
  if (!reqUrl.startsWith('/') || reqUrl.startsWith('//') || reqUrl.includes('\\')) return null
  if (pathOnly.includes('@')) return null
  const prefix = base.href.endsWith('/') ? base.href : `${base.href}/`
  let target: URL
  try {
    target = new URL(reqUrl.slice(1), prefix)
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
