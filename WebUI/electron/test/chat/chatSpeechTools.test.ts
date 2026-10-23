import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertToModelMessages, type FilePart } from 'ai'

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../kernel/kernelBus', () => ({
  emitActivity: vi.fn(),
  getKernelEventWindow: vi.fn(() => null),
}))
const saveGeneratedAudioFileMock = vi.fn(async () => '/audio/clip.wav')
vi.mock('../../persist/audioFiles', () => ({
  saveGeneratedAudioFile: saveGeneratedAudioFileMock,
}))
const requestSpeechMock = vi.fn()
vi.mock('../../chat/chatAsk', () => ({ askRenderer: requestSpeechMock }))

const { executeChatSpeechTool } = await import('../../chat/chatSpeechTools')
const { filePartToBase64 } = await import('../../chat/chatFileParts')

const readMediaAsDataUri = vi.fn(async () => 'data:audio/wav;base64,QQ==')

beforeEach(() => {
  requestSpeechMock.mockReset()
  saveGeneratedAudioFileMock.mockClear()
  readMediaAsDataUri.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('filePartToBase64', () => {
  it('decodes a data URL without fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await filePartToBase64('data:audio/wav;base64,QQ==', readMediaAsDataUri)).toBe('QQ==')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('unwraps a v7 { type: url } file part', async () => {
    expect(
      await filePartToBase64(
        { type: 'url', url: 'data:audio/wav;base64,QQ==' },
        readMediaAsDataUri,
      ),
    ).toBe('QQ==')
  })

  // The wrapper the SDK really builds holds a URL instance, not a string, so
  // this goes through `convertToModelMessages` rather than a hand-written part.
  it('reads the attachment shape convertToModelMessages produces', async () => {
    const [message] = await convertToModelMessages([
      {
        role: 'user',
        parts: [{ type: 'file', mediaType: 'audio/wav', url: 'aipg-media://media/input/clip.wav' }],
      },
    ])
    const part = (message.content as FilePart[])[0]
    expect(await filePartToBase64(part.data, readMediaAsDataUri)).toBe('QQ==')
    expect(readMediaAsDataUri).toHaveBeenCalledWith('aipg-media://media/input/clip.wav')
  })

  it('reads aipg-media:// through the engine reader instead of fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await filePartToBase64('aipg-media://voice.wav', readMediaAsDataUri)).toBe('QQ==')
    expect(readMediaAsDataUri).toHaveBeenCalledWith('aipg-media://voice.wav')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('encodes raw bytes', async () => {
    expect(await filePartToBase64(new Uint8Array([65]), readMediaAsDataUri)).toBe('QQ==')
  })
})

describe('executeChatSpeechTool', () => {
  it('synthesizes, names the file after the thread, and writes it in main', async () => {
    requestSpeechMock.mockResolvedValue({
      audioBase64: 'QQ==',
      mediaType: 'audio/wav',
      voice: 'Vivian',
      engine: 'qwen3',
      mode: 'custom_voice',
      language: 'English',
    })

    const result = await executeChatSpeechTool({
      toolName: 'synthesizeTextToSpeech',
      input: { text: 'hello there', speaker: 'Vivian' },
      conversationKey: 'conv-12345678',
      conversationLabel: 'Trip planning',
      readMediaAsDataUri,
    })

    expect(requestSpeechMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'speech-synthesize', text: 'hello there' }),
      expect.anything(),
    )
    const [audioBase64, fileName] = saveGeneratedAudioFileMock.mock.calls[0] as unknown as [
      string,
      string,
    ]
    expect(audioBase64).toBe('QQ==')
    expect(fileName).toMatch(/^Trip_planning_/)
    expect(fileName.endsWith('.wav')).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      savedFilePath: '/audio/clip.wav',
      speaker: 'Vivian',
      mode: 'custom_voice',
    })
  })

  it('reports a failed synthesis as a tool error instead of throwing', async () => {
    requestSpeechMock.mockRejectedValue(new Error('Voice model download declined'))

    const result = await executeChatSpeechTool({
      toolName: 'synthesizeTextToSpeech',
      input: { text: 'hello' },
      conversationKey: 'conv-1',
      readMediaAsDataUri,
    })

    expect(result).toEqual({ ok: false, message: 'Voice model download declined' })
    expect(saveGeneratedAudioFileMock).not.toHaveBeenCalled()
  })

  it('transcribes the latest audio attachment on the turn', async () => {
    requestSpeechMock.mockResolvedValue({ text: 'the recorded words' })

    const result = await executeChatSpeechTool({
      toolName: 'transcribeAudio',
      input: {},
      conversationKey: 'conv-1',
      readMediaAsDataUri,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', mediaType: 'audio/ogg', data: new Uint8Array([65]) },
            { type: 'text', text: 'what was said?' },
          ],
        },
      ] as never,
    })

    expect(requestSpeechMock).toHaveBeenCalledWith(
      {
        kind: 'speech-transcribe',
        audioBase64: 'QQ==',
        mediaType: 'audio/ogg',
      },
      expect.anything(),
    )
    expect(result).toEqual({
      ok: true,
      message: 'Transcribed audio.',
      transcript: 'the recorded words',
    })
  })

  it('tells the model when the conversation has no audio', async () => {
    const result = await executeChatSpeechTool({
      toolName: 'transcribeAudio',
      input: {},
      conversationKey: 'conv-1',
      readMediaAsDataUri,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never,
    })

    expect(requestSpeechMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      message: 'No audio attachment found in the conversation to transcribe.',
    })
  })
})
