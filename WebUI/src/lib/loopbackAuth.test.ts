import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateBackendAuthToken, qwen3TtsFetch } from './loopbackAuth'

// Loopback tokens are regenerated on every backend spawn. These cover the two ways
// the renderer copes with that: the reactive one (retry once on 401) and the
// proactive one (drop the cache when we ourselves restart the service).

const getBackendAuthToken = vi.fn<(service: string) => Promise<string>>()
const fetchMock = vi.fn<typeof fetch>()

function tokenOf(call: Parameters<typeof fetch>): string | null {
  return new Headers(call[1]?.headers ?? {}).get('X-AIPG-Auth')
}

beforeEach(() => {
  getBackendAuthToken.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('window', { electronAPI: { getBackendAuthToken } })
  vi.stubGlobal('fetch', fetchMock)
  // Every test starts from a cold cache — it is module-level state.
  invalidateBackendAuthToken('qwen3-tts-backend')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('qwen3TtsFetch', () => {
  it('attaches the loopback token and caches it across calls', async () => {
    getBackendAuthToken.mockResolvedValue('token-1')
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    await qwen3TtsFetch('http://127.0.0.1:1/api/load', { method: 'POST' })
    await qwen3TtsFetch('http://127.0.0.1:1/api/load', { method: 'POST' })

    expect(getBackendAuthToken).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.map(tokenOf)).toEqual(['token-1', 'token-1'])
  })

  it('refreshes and retries once when the backend rejects a stale token', async () => {
    getBackendAuthToken.mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh')
    fetchMock
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))

    const response = await qwen3TtsFetch('http://127.0.0.1:1/api/load', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls.map(tokenOf)).toEqual(['stale', 'fresh'])
  })
})

describe('invalidateBackendAuthToken', () => {
  it('makes the next request fetch a fresh token, not spend a 401 on the stale one', async () => {
    getBackendAuthToken
      .mockResolvedValueOnce('before-restart')
      .mockResolvedValueOnce('after-restart')
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    await qwen3TtsFetch('http://127.0.0.1:1/api/load', { method: 'POST' })
    // What `backendServices.startService` does: the spawn rotates the token.
    invalidateBackendAuthToken('qwen3-tts-backend')
    await qwen3TtsFetch('http://127.0.0.1:1/api/load', { method: 'POST' })

    expect(fetchMock.mock.calls.map(tokenOf)).toEqual(['before-restart', 'after-restart'])
    // No rejected request in between — the restarted service is hit with the new
    // token on the very first call.
    expect(fetchMock.mock.calls).toHaveLength(2)
  })

  it('only drops the named service, leaving other services cached', async () => {
    getBackendAuthToken.mockResolvedValue('tts-token')
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    await qwen3TtsFetch('http://127.0.0.1:1/api/load', { method: 'POST' })
    invalidateBackendAuthToken('comfyui-backend')
    await qwen3TtsFetch('http://127.0.0.1:1/api/load', { method: 'POST' })

    expect(getBackendAuthToken).toHaveBeenCalledTimes(1)
  })
})
