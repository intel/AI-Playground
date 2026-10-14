import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { net } from 'electron'
import { setAllowedUpstreams, startCloudProxy, type CloudProxy } from '../../adapters/cloudProxy'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  net: { fetch: vi.fn() },
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getKey = vi.fn((providerId: string) => (providerId === 'openai' ? 'sk-secret' : null))

function request(
  port: number,
  init: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: init.method ?? 'GET',
        path: init.path ?? '/v1/models',
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('error', reject)
    if (init.body) req.write(init.body)
    req.end()
  })
}

function portOf(proxy: CloudProxy): number {
  return Number(new URL(proxy.url).port)
}

describe('cloud proxy', () => {
  let proxy: CloudProxy

  beforeEach(async () => {
    getKey.mockClear()
    setAllowedUpstreams([])
    vi.mocked(net.fetch).mockReset()
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    proxy = await startCloudProxy(getKey)
  })

  afterEach(() => {
    proxy.close()
    setAllowedUpstreams([])
  })

  it('rejects a missing token before decrypting a key', async () => {
    setAllowedUpstreams([{ id: 'openai', baseUrl: 'https://api.openai.com/v1' }])
    const response = await request(portOf(proxy), {
      headers: {
        'x-cloud-provider': 'openai',
        'x-cloud-upstream': 'https://attacker.example',
      },
    })
    expect(response.status).toBe(401)
    expect(getKey).not.toHaveBeenCalled()
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('rejects a wrong token and a different-length token', async () => {
    setAllowedUpstreams([{ id: 'openai', baseUrl: 'https://api.openai.com/v1' }])
    const wrong = await request(portOf(proxy), {
      headers: {
        'x-aipg-auth': 'f'.repeat(proxy.authToken.length),
        'x-cloud-provider': 'openai',
        'x-cloud-upstream': 'https://api.openai.com',
      },
    })
    const short = await request(portOf(proxy), {
      headers: {
        'x-aipg-auth': 'x',
        'x-cloud-provider': 'openai',
        'x-cloud-upstream': 'https://api.openai.com',
      },
    })
    expect(wrong.status).toBe(401)
    expect(short.status).toBe(401)
    expect(getKey).not.toHaveBeenCalled()
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('answers CORS preflight without a token', async () => {
    const response = await request(portOf(proxy), { method: 'OPTIONS', path: '/v1/models' })
    expect(response.status).toBe(204)
    expect(getKey).not.toHaveBeenCalled()
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('fetches a registered base and attaches the bearer key', async () => {
    setAllowedUpstreams([{ id: 'openai', baseUrl: 'https://api.openai.com/v1' }])
    const response = await request(portOf(proxy), {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        'x-aipg-auth': proxy.authToken,
        'x-cloud-provider': 'openai',
        'x-cloud-upstream': 'https://api.openai.com',
        'x-cloud-auth-style': 'bearer',
        'content-type': 'application/json',
      },
      body: '{"model":"gpt-test"}',
    })
    expect(response.status).toBe(200)
    expect(response.body).toBe('{"ok":true}')
    expect(getKey).toHaveBeenCalledTimes(1)
    expect(getKey).toHaveBeenCalledWith('openai')
    expect(net.fetch).toHaveBeenCalledTimes(1)
    const [target, init] = vi.mocked(net.fetch).mock.calls[0]
    expect(String(target)).toBe('https://api.openai.com/v1/chat/completions')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-secret')
    expect(init?.redirect).toBe('error')
  })

  it('rejects an unregistered provider, a foreign host, and a file URL', async () => {
    setAllowedUpstreams([
      { id: 'openai', baseUrl: 'https://api.openai.com/v1' },
      { id: 'files', baseUrl: 'file:///etc/passwd' },
    ])
    const headers = {
      'x-aipg-auth': proxy.authToken,
      'x-cloud-auth-style': 'bearer',
    }
    const unregistered = await request(portOf(proxy), {
      headers: {
        ...headers,
        'x-cloud-provider': 'other',
        'x-cloud-upstream': 'https://api.openai.com',
      },
    })
    const foreign = await request(portOf(proxy), {
      headers: {
        ...headers,
        'x-cloud-provider': 'openai',
        'x-cloud-upstream': 'https://attacker.example',
      },
    })
    const fileUrl = await request(portOf(proxy), {
      headers: {
        ...headers,
        'x-cloud-provider': 'files',
        'x-cloud-upstream': 'file:///etc/passwd',
      },
    })
    const userinfo = await request(portOf(proxy), {
      headers: {
        ...headers,
        'x-cloud-provider': 'openai',
        'x-cloud-upstream': 'https://user:pass@api.openai.com',
      },
    })
    expect(unregistered.status).toBe(403)
    expect(foreign.status).toBe(403)
    expect(fileUrl.status).toBe(403)
    expect(userinfo.status).toBe(403)
    expect(getKey).not.toHaveBeenCalled()
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('rejects a request target that leaves the registered origin', async () => {
    setAllowedUpstreams([{ id: 'openai', baseUrl: 'https://api.openai.com/v1' }])
    const headers = {
      'x-aipg-auth': proxy.authToken,
      'x-cloud-provider': 'openai',
      'x-cloud-upstream': 'https://api.openai.com',
    }
    const protocolRelative = await request(portOf(proxy), {
      path: '//attacker.example/steal',
      headers,
    })
    const absolute = await request(portOf(proxy), {
      path: '/https://attacker.example/steal',
      headers,
    })
    expect(protocolRelative.status).toBe(403)
    expect(absolute.status).toBe(403)
    expect(getKey).not.toHaveBeenCalled()
    expect(net.fetch).not.toHaveBeenCalled()
  })
})
