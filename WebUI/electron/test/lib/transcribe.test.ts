import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribeAudioBuffer } from '@/lib/transcribe'

// Transcription talks to whatever OpenAI-compatible server the user points it
// at: the OVMS Whisper server, or a fallback endpoint such as whisper.cpp's
// `whisper-server`. These tests pin the request we send and, more importantly,
// which replies count as a transcript — the reason this code no longer goes
// through the AI SDK is that asking for `verbose_json` made whisper.cpp's
// perfectly good answer fail schema validation as "Invalid JSON response".

vi.mock('@/lib/audioUtils', () => ({
  convertToWav: vi.fn(async (blob: Blob) => blob),
}))

const ENDPOINT = { baseURL: 'http://127.0.0.1:2022/v1', model: 'whisper-1', apiKey: '' }

const fetchMock = vi.fn()

function reply(body: string, init?: { status?: number; contentType?: string }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { 'content-type': init?.contentType ?? 'application/json' },
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function transcribe(): Promise<string> {
  return transcribeAudioBuffer(new ArrayBuffer(8), ENDPOINT)
}

describe('transcribeAudioBuffer', () => {
  it('posts the audio as multipart form data asking for plain json', async () => {
    fetchMock.mockResolvedValue(reply('{"text":"hello there"}'))

    await transcribe()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:2022/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('response_format')).toBe('json')
    expect(form.get('file')).toBeInstanceOf(File)
    // No key configured, so no Authorization header (which would provoke a CORS
    // preflight that local servers often do not answer).
    expect(init.headers).toEqual({})
  })

  it('sends the API key when one is configured', async () => {
    fetchMock.mockResolvedValue(reply('{"text":"hi"}'))

    await transcribeAudioBuffer(new ArrayBuffer(8), { ...ENDPOINT, apiKey: 'secret' })

    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer secret' })
  })

  it('returns the trimmed transcript', async () => {
    fetchMock.mockResolvedValue(reply('{"text":" hello there \\n"}'))

    expect(await transcribe()).toBe('hello there')
  })

  // whisper.cpp answers verbose_json with segments that lack `seek` and
  // `compression_ratio`; reading only `text` keeps that reply usable.
  it('accepts a verbose reply whose segments are not OpenAI-shaped', async () => {
    fetchMock.mockResolvedValue(
      reply(
        JSON.stringify({
          task: 'transcribe',
          language: 'english',
          duration: 1,
          text: ' a spoken sentence\n',
          segments: [{ id: 0, text: ' a spoken sentence', start: 0, end: 1, tokens: [2411] }],
        }),
      ),
    )

    expect(await transcribe()).toBe('a spoken sentence')
  })

  it('accepts a plain-text reply', async () => {
    fetchMock.mockResolvedValue(reply('just text\n', { contentType: 'text/plain' }))

    expect(await transcribe()).toBe('just text')
  })

  it('reports the server message for a failed request', async () => {
    fetchMock.mockResolvedValue(
      reply('{"error":"FFmpeg conversion failed."}', { status: 500, contentType: 'text/plain' }),
    )

    await expect(transcribe()).rejects.toThrow(
      'Transcription failed (500): FFmpeg conversion failed.',
    )
  })

  it('reports an OpenAI-shaped error object', async () => {
    fetchMock.mockResolvedValue(reply('{"error":{"message":"model not found"}}', { status: 404 }))

    await expect(transcribe()).rejects.toThrow('Transcription failed (404): model not found')
  })

  it('refuses to pass an HTML page off as a transcript', async () => {
    fetchMock.mockResolvedValue(
      reply('<html><body>File Not Found</body></html>', { contentType: 'text/html' }),
    )

    await expect(transcribe()).rejects.toThrow(/was not JSON: <html>/)
  })

  it('rejects a JSON reply with no text field', async () => {
    fetchMock.mockResolvedValue(reply('{"segments":[]}'))

    await expect(transcribe()).rejects.toThrow(/carried no text/)
  })
})
