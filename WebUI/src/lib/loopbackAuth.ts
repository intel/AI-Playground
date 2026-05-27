import type { BackendServiceName } from '@/assets/js/store/backendServices'

// Per-launch loopback auth tokens for AI Playground's local backend services.
// The Electron main process generates a fresh token on every spawn; the
// renderer must attach it on every fetch / WebSocket so that other local
// processes (low-IL, host-networked containers, etc.) cannot reach the API.
//
// The cache is invalidated whenever a fetch fails with 401, in case the
// backend was restarted under us with a fresh token.

const tokenCache = new Map<BackendServiceName, string>()

async function loadToken(serviceName: BackendServiceName, forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = tokenCache.get(serviceName)
    if (cached) return cached
  }
  const fresh = await window.electronAPI.getBackendAuthToken(serviceName)
  if (fresh) tokenCache.set(serviceName, fresh)
  else tokenCache.delete(serviceName)
  return fresh
}

function invalidate(serviceName: BackendServiceName) {
  tokenCache.delete(serviceName)
}

/**
 * Wraps `fetch` for the ai-backend (Flask) service, attaching the loopback
 * auth token via the `X-AIPG-Auth` request header.
 *
 * The `Authorization: Bearer ...` header is reserved for endpoint-specific
 * semantics (e.g. forwarding the user's HuggingFace token to
 * `/api/downloadModel`), so we use a separate header for the local
 * machine-to-machine auth.
 */
export async function aipgFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let token = await loadToken('ai-backend')
  const buildInit = (t: string): RequestInit => {
    const headers = new Headers(init?.headers ?? {})
    if (t) headers.set('X-AIPG-Auth', t)
    return { ...(init ?? {}), headers }
  }
  let response = await fetch(input, buildInit(token))
  if (response.status === 401) {
    invalidate('ai-backend')
    token = await loadToken('ai-backend')
    if (token) {
      response = await fetch(input, buildInit(token))
    }
  }
  return response
}

/**
 * Returns the current ComfyUI loopback token. Fetches and caches lazily.
 * Used both for `Authorization: Bearer ...` headers on HTTP calls and for
 * `?token=...` query parameters on the WebSocket URL (browsers cannot set
 * custom headers on WebSocket upgrades).
 *
 * Pass `forceRefresh=true` for code paths where a stale token cannot be
 * recovered from (e.g. a WebSocket upgrade — a rejected upgrade just looks
 * like a `close` event with no auth-specific status code, so we cannot do
 * the same retry-on-401 trick we use for HTTP).
 */
export async function getComfyAuthToken(forceRefresh = false): Promise<string> {
  return loadToken('comfyui-backend', forceRefresh)
}

/**
 * Invalidate the cached ComfyUI token. The renderer should call this if a
 * ComfyUI fetch returns 401, in case the backend was restarted with a fresh
 * env token.
 */
export function invalidateComfyAuthToken(): void {
  invalidate('comfyui-backend')
}

/**
 * Returns the current Home Agent loopback token. Used by the AI SDK chat
 * fetch when Home Agent is the active backend so requests to the bundled
 * `home-agent` Flask proxy carry `X-AIPG-Auth`.
 */
export async function getHomeAgentAuthToken(forceRefresh = false): Promise<string> {
  return loadToken('home-agent-backend', forceRefresh)
}

/** Invalidate the cached Home Agent token (e.g. on 401 retry). */
export function invalidateHomeAgentAuthToken(): void {
  invalidate('home-agent-backend')
}
