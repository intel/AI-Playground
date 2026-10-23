import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  clearQueue,
  comfyFetch,
  getComfySocket,
  interruptExecution,
  resetComfySocketsForTest,
  submitPrompt,
  uploadInputFile,
  releaseComfySocket,
  type ComfyClientDeps,
} from '../../artifact/comfyClient'

/** Minimal fake of the WHATWG WebSocket the client talks to. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  binaryType = 'arraybuffer'
  readyState = 0
  url: string
  closed = false
  private listeners = new Map<string, ((event: unknown) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  simulateOpen() {
    this.readyState = 1
    this.dispatch('open', {})
  }

  simulateClose(code: number, reason = '') {
    this.readyState = 3
    this.dispatch('close', { code, reason })
  }

  close() {
    this.closed = true
    this.readyState = 3
  }
}

type RecordedRequest = { url: string; init: RequestInit }
type FakeResponse = { status: number; text?: string }

describe('comfyClient', () => {
  const baseUrl = 'http://127.0.0.1:49123'
  let requests: RecordedRequest[] = []
  let responses: FakeResponse[]
  let tokens: string[]
  let fetchMock: ReturnType<typeof vi.fn>

  const deps = (): ComfyClientDeps => ({
    getServiceBaseUrl: () => baseUrl,
    getToken: () => tokens.shift() ?? '',
  })

  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    resetComfySocketsForTest()
    requests = []
    responses = []
    tokens = []
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} })
      const next = responses.shift() ?? { status: 200 }
      return {
        status: next.status,
        text: async () => next.text ?? '',
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetComfySocketsForTest()
  })

  it('sends the loopback bearer token and retries once on 401 with a fresh token', async () => {
    tokens = ['first-token', 'fresh-token']
    responses = [{ status: 401 }, { status: 200, text: '{}' }]
    const response = await comfyFetch(baseUrl, deps(), '/health')
    expect(response.status).toBe(200)
    expect(requests).toHaveLength(2)
    expect(new Headers(requests[0].init.headers).get('Authorization')).toBe('Bearer first-token')
    expect(new Headers(requests[1].init.headers).get('Authorization')).toBe('Bearer fresh-token')
  })

  it('does not retry a 401 when there is no fresh token', async () => {
    tokens = ['']
    responses = [{ status: 401 }]
    const response = await comfyFetch(baseUrl, deps(), '/health')
    expect(response.status).toBe(401)
    expect(requests).toHaveLength(1)
  })

  it('submits a prompt with the workflow and client id', async () => {
    tokens = ['fresh-token']
    await submitPrompt(baseUrl, deps(), { '1': { class_type: 'EmptyImage' } }, 'client-1')
    expect(requests.at(-1)).toMatchObject({ url: `${baseUrl}/prompt` })
    const init = requests.at(-1)!.init
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toContain('application/json')
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: { '1': { class_type: 'EmptyImage' } },
      client_id: 'client-1',
    })
  })

  it('throws with the backend text when the prompt is refused', async () => {
    tokens = ['fresh-token']
    responses = [{ status: 500, text: 'boom' }]
    await expect(submitPrompt(baseUrl, deps(), {}, 'client-1')).rejects.toThrow(
      'ComfyUI Backend responded with 500: boom',
    )
  })

  it('interrupts and clears the queue', async () => {
    tokens = ['fresh-token', 'fresh-token']
    await interruptExecution(baseUrl, deps())
    await clearQueue(baseUrl, deps())
    expect(requests.at(-2)!.url).toBe(`${baseUrl}/interrupt`)
    expect(requests.at(-2)!.init.method).toBe('POST')
    expect(requests.at(-1)!.url).toBe(`${baseUrl}/queue`)
    expect(requests.at(-1)!.init.method).toBe('POST')
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({ clear: true })
  })

  it('uploads an input file as multipart form data with overwrite', async () => {
    tokens = ['fresh-token']
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    await uploadInputFile(baseUrl, deps(), { name: 'abc.png', blob, subfolder: '3d' })
    const request = requests.at(-1)!
    expect(request.url).toBe(`${baseUrl}/upload/image`)
    expect(request.init.method).toBe('POST')
    const body = request.init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect((body.get('image') as File).name).toBe('abc.png')
    expect(body.get('overwrite')).toBe('true')
    expect(body.get('subfolder')).toBe('3d')
  })

  describe('getComfySocket', () => {
    it('puts the fresh token in the /ws query string and reuses the connecting socket', () => {
      tokens = ['ws-token', 'ws-token']
      const handlers = { onBinaryPreview: vi.fn(), onJson: vi.fn(), onClose: vi.fn() }
      const handle = getComfySocket(baseUrl, deps(), 'client-1', handlers)
      expect(FakeWebSocket.instances).toHaveLength(1)
      const socket = FakeWebSocket.instances[0]
      expect(socket.url).toContain(`/ws?clientId=client-1&token=${encodeURIComponent('ws-token')}`)

      const second = getComfySocket(baseUrl, deps(), 'client-1', handlers)
      expect(second).toBe(handle)
      expect(FakeWebSocket.instances).toHaveLength(1)
    })

    it('dispatches binary previews with the format field and JSON messages to the handlers', () => {
      const handlers = { onBinaryPreview: vi.fn(), onJson: vi.fn(), onClose: vi.fn() }
      getComfySocket(baseUrl, deps(), 'client-1', handlers)
      const socket = FakeWebSocket.instances[0]

      // u32 event type 1 (PREVIEW_IMAGE), u32 format 2 (PNG), then payload.
      const frame = new ArrayBuffer(8 + 2)
      const view = new DataView(frame)
      view.setUint32(0, 1)
      view.setUint32(4, 2)
      new Uint8Array(frame, 8).set([0xca, 0xfe])
      socket.dispatch('message', { data: frame })
      expect(handlers.onBinaryPreview).toHaveBeenCalledWith('image/png', expect.any(ArrayBuffer))

      socket.dispatch('message', { data: '{"type":"progress","data":{"value":1,"max":4}}' })
      expect(handlers.onJson).toHaveBeenCalledWith({ type: 'progress', data: { value: 1, max: 4 } })
    })

    it('replaces handlers for the next run and reports closes', () => {
      const first = { onBinaryPreview: vi.fn(), onJson: vi.fn(), onClose: vi.fn() }
      const second = { onBinaryPreview: vi.fn(), onJson: vi.fn(), onClose: vi.fn() }
      getComfySocket(baseUrl, deps(), 'client-1', first)
      getComfySocket(baseUrl, deps(), 'client-1', second)
      const socket = FakeWebSocket.instances[0]

      socket.dispatch('message', { data: '{"type":"status"}' })
      expect(second.onJson).toHaveBeenCalledTimes(1)
      expect(first.onJson).not.toHaveBeenCalled()

      socket.simulateClose(1006)
      expect(second.onClose).toHaveBeenCalledWith(1006, '')
      // The closed socket is dropped, so the next connect creates a fresh one.
      getComfySocket(baseUrl, deps(), 'client-1', second)
      expect(FakeWebSocket.instances).toHaveLength(2)
    })

    it('releaseComfySocket drops the connection so the next run opens a fresh one', () => {
      const handlers = { onBinaryPreview: vi.fn(), onJson: vi.fn(), onClose: vi.fn() }
      getComfySocket(baseUrl, deps(), 'client-1', handlers)
      expect(FakeWebSocket.instances).toHaveLength(1)
      FakeWebSocket.instances[0].simulateOpen()

      releaseComfySocket(baseUrl)
      expect(FakeWebSocket.instances[0].closed).toBe(true)

      getComfySocket(baseUrl, deps(), 'client-2', handlers)
      expect(FakeWebSocket.instances).toHaveLength(2)
    })
  })
})
