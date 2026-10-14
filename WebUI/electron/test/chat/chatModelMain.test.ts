import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModelV4 } from '@ai-sdk/provider'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  createMainChatModel,
  setChatModelDeps,
  resetChatModelDepsForTest,
  chatInferenceStreamsActive,
} = await import('../../chat/chatModelMain')

type FetchMock = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Response>>>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function completionBody(content: string): unknown {
  return {
    id: 'cmpl-1',
    object: 'chat.completion',
    created: 123,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function localConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backend: 'llamaCPP',
    modelId: 'Qwen/Qwen3-9B',
    baseUrl: 'http://127.0.0.1:39100',
    readiness: {
      serviceName: 'llamacpp-backend',
      llmModelName: 'Qwen---Qwen3-9B',
    },
    ...overrides,
  }
}

function wireDeps(overrides: Record<string, unknown> = {}): {
  llmApiBase: ReturnType<typeof vi.fn>
  ensureBackendReadiness: ReturnType<typeof vi.fn>
  homeAgentAuthToken: ReturnType<typeof vi.fn>
  cloudProxyAuthToken: ReturnType<typeof vi.fn>
} {
  const llmApiBase = vi.fn(() => 'http://127.0.0.1:39100')
  const ensureBackendReadiness = vi.fn(async () => {})
  const homeAgentAuthToken = vi.fn(() => 'token-1')
  const cloudProxyAuthToken = vi.fn(() => 'cloud-token')
  setChatModelDeps({
    llmApiBase: llmApiBase as never,
    ensureBackendReadiness: ensureBackendReadiness as never,
    homeAgentAuthToken,
    cloudProxyAuthToken,
    ...overrides,
  })
  return { llmApiBase, ensureBackendReadiness, homeAgentAuthToken, cloudProxyAuthToken }
}

async function generate(model: ReturnType<typeof createMainChatModel>): Promise<unknown> {
  return await (model as unknown as LanguageModelV4).doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as never)
}

describe('createMainChatModel', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    resetChatModelDepsForTest()
  })

  it('encodes local model ids with --- but not cloud ones', async () => {
    wireDeps()
    const fetchMock = vi.fn(async () => jsonResponse(completionBody('hi'))) as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    await generate(createMainChatModel(localConfig() as never))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('Qwen---Qwen3-9B')

    await generate(
      createMainChatModel(
        localConfig({ backend: 'cloud', modelId: 'gpt-test', readiness: undefined }) as never,
      ),
    )
    const cloudBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(cloudBody.model).toBe('gpt-test')
  })

  it('re-roots each request onto the live backend base, port and version path', async () => {
    const { llmApiBase } = wireDeps()
    const fetchMock = vi.fn(async () => jsonResponse(completionBody('hi'))) as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    const model = createMainChatModel(localConfig() as never)
    await generate(model)
    llmApiBase.mockReturnValue('http://127.0.0.1:39200/v3')
    await generate(model)
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toBe('http://127.0.0.1:39100/v1/chat/completions')
    expect(urls[1]).toBe('http://127.0.0.1:39200/v3/chat/completions')
  })

  it('merges sampling and chat_template_kwargs and can omit the model', async () => {
    wireDeps()
    const fetchMock = vi.fn(async () => jsonResponse(completionBody('hi'))) as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    await generate(
      createMainChatModel(
        localConfig({
          backend: 'cloud',
          modelId: 'default',
          omitModelInBody: true,
          samplingRequestBody: { top_p: 0.9, min_p: 0.05 },
          chatTemplateKwargs: { enable_thinking: false },
        }) as never,
      ),
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBeUndefined()
    expect(body.top_p).toBe(0.9)
    expect(body.min_p).toBe(0.05)
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('routes through the Home Agent proxy with auth and retries once on 401', async () => {
    const { homeAgentAuthToken } = wireDeps()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('denied', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(completionBody('hi'))) as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    homeAgentAuthToken.mockReturnValueOnce('stale').mockReturnValueOnce('fresh')
    await generate(
      createMainChatModel(
        localConfig({ homeAgentUpstreamUrl: 'http://127.0.0.1:59000/v1' }) as never,
      ),
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = fetchMock.mock.calls[0][1] as RequestInit
    const second = fetchMock.mock.calls[1][1] as RequestInit
    expect(new Headers(first.headers).get('X-Upstream-Url')).toBe('http://127.0.0.1:59000/v1')
    expect(new Headers(first.headers).get('X-AIPG-Auth')).toBe('stale')
    expect(new Headers(second.headers).get('X-AIPG-Auth')).toBe('fresh')
  })

  it('retries a transient restart signal until the route is mounted', async () => {
    wireDeps()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Invalid request URL' }, 400))
      .mockResolvedValueOnce(jsonResponse(completionBody('hi'))) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    await generate(createMainChatModel(localConfig() as never))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('relaunches the backend once and retries a thrown fetch', async () => {
    const { ensureBackendReadiness } = wireDeps()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(completionBody('hi'))) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    await generate(createMainChatModel(localConfig() as never))
    expect(ensureBackendReadiness).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not relaunch when the request was aborted', async () => {
    const { ensureBackendReadiness } = wireDeps()
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException('aborted', 'AbortError')) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      (async () => {
        const model = createMainChatModel(localConfig() as never)
        const controller = new AbortController()
        controller.abort()
        await (model as unknown as LanguageModelV4).doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          abortSignal: controller.signal,
        } as never)
      })(),
    ).rejects.toThrow()
    expect(ensureBackendReadiness).not.toHaveBeenCalled()
  })

  it('tracks the inference stream from dispatch until the body drains', async () => {
    wireDeps()
    const fetchMock = vi.fn(async () => jsonResponse(completionBody('hi'))) as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    expect(chatInferenceStreamsActive()).toBe(0)
    const model = createMainChatModel(localConfig() as never)
    await generate(model)
    expect(chatInferenceStreamsActive()).toBe(0)
  })

  it('settles the stream counter when the body errors', async () => {
    wireDeps()
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('socket reset'))
            },
          }),
          { status: 200 },
        ),
    ) as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    const model = createMainChatModel(localConfig() as never)
    await expect(generate(model)).rejects.toThrow()
    expect(chatInferenceStreamsActive()).toBe(0)
  })

  it('extracts cloud <think> reasoning into a reasoning part', async () => {
    wireDeps()
    const fetchMock = vi.fn(async () =>
      jsonResponse(completionBody('<think>plan first</think>Hello')),
    ) as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    const model = createMainChatModel(
      localConfig({
        backend: 'cloud',
        modelId: 'gpt-test',
        extractReasoning: true,
        readiness: undefined,
        cloud: { providerId: 'openai', authStyle: 'bearer' },
      }) as never,
    )
    const result = (await generate(model)) as {
      content: Array<{ type: string; text?: string }>
    }
    const types = result.content.map((part) => part.type)
    expect(types).toContain('reasoning')
    const reasoning = result.content.find((part) => part.type === 'reasoning')
    expect(reasoning?.text).toContain('plan first')
    const text = result.content.find((part) => part.type === 'text')
    expect(text?.text).toBe('Hello')
  })

  it('attaches the cloud proxy loopback token', async () => {
    const { cloudProxyAuthToken } = wireDeps()
    const fetchMock = vi.fn(async () => jsonResponse(completionBody('hi'))) as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    await generate(
      createMainChatModel(
        localConfig({
          backend: 'cloud',
          modelId: 'gpt-test',
          readiness: undefined,
          cloud: {
            providerId: 'openai',
            upstreamBaseUrl: 'https://api.openai.com',
            authStyle: 'bearer',
          },
        }) as never,
      ),
    )
    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers)
    expect(cloudProxyAuthToken).toHaveBeenCalled()
    expect(headers.get('X-AIPG-Auth')).toBe('cloud-token')
    expect(headers.get('X-Cloud-Provider')).toBe('openai')
    expect(headers.get('X-Cloud-Upstream')).toBe('https://api.openai.com')
  })
})
