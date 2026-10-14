import { afterEach, describe, expect, it, vi } from 'vitest'
import { net } from 'electron'
import { fetchCloudUpstream } from '../../adapters/cloudUpstream'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  net: { fetch: vi.fn() },
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getKey = vi.fn((providerId: string) => (providerId === 'openai' ? 'sk-secret' : null))

describe('fetchCloudUpstream', () => {
  afterEach(() => {
    getKey.mockClear()
    vi.mocked(net.fetch).mockReset()
  })

  it('attaches a bearer key and pins the request to the provider base', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    await fetchCloudUpstream({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      authStyle: 'bearer',
      url: '/v1/chat/completions',
      init: {
        method: 'POST',
        headers: { authorization: 'Bearer dummy' },
        body: '{}',
      },
      getKey,
    })
    expect(getKey).toHaveBeenCalledWith('openai')
    expect(net.fetch).toHaveBeenCalledTimes(1)
    const [target, init] = vi.mocked(net.fetch).mock.calls[0]
    expect(String(target)).toBe('https://api.openai.com/v1/chat/completions')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-secret')
    expect(init?.redirect).toBe('error')
  })

  it.each([
    ['file:', 'file:///etc/passwd', '/v1/models'],
    ['userinfo', 'https://user:pass@api.openai.com/v1', '/v1/models'],
    ['a foreign host', 'https://api.openai.com/v1', 'https://evil.example/v1/models'],
    ['a path that leaves the base', 'https://gateway.example/openai', '/../secret'],
  ])('rejects %s before reading a key or fetching', async (_label, baseUrl, url) => {
    await expect(
      fetchCloudUpstream({
        providerId: 'openai',
        baseUrl,
        authStyle: 'bearer',
        url,
        getKey,
      }),
    ).rejects.toThrow('upstream not allowed')
    expect(getKey).not.toHaveBeenCalled()
    expect(net.fetch).not.toHaveBeenCalled()
  })
})
