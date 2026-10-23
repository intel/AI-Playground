import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Engine selection and availability are read at call time, so refs keep them
// mutable per test without re-importing the SUT.
const sttEngine = ref<'whisper' | 'standalone' | 'external'>('whisper')
const sttAvailable = ref(true)
const ttsEngine = ref<'qwen3' | 'kokoro' | 'external'>('qwen3')
const ttsAvailable = ref(true)
const ttsKokoroAvailable = ref(true)
const ttsExternalAvailable = ref(true)
const qwenBackendSetUp = ref(true)
const qwenModelLoaded = ref(false)

const ensureWhisperReadyMock = vi.fn(async () => ({ downloadPrompted: false }))
const ensureStandaloneReadyMock = vi.fn(async () => ({ downloadPrompted: false }))
const ensureStandaloneServerRunningMock = vi.fn(async () => {})
const ensureTranscriptionServerRunningMock = vi.fn(async () => {})
const resolveTranscriptionMock = vi.fn(
  async (..._args: unknown[]): Promise<{ baseURL: string; model: string; apiKey: string } | null> =>
    null,
)

const ensureSpeechServerRunningMock = vi.fn(async () => {})
const resolveSpeechMock = vi.fn(
  async (
    ..._args: unknown[]
  ): Promise<{
    baseURL: string
    model: string
    voice: string
    apiKey: string
  } | null> => null,
)
const synthesizeToWavMock = vi.fn(async () => ({ audioBase64: 'Tts9', voice: 'af_heart' }))

const qwenIsModelInstalledMock = vi.fn(async () => true)
const qwenIsModelLoadedMock = vi.fn(async () => qwenModelLoaded.value)
const qwenEnsureModelLoadedMock = vi.fn(async () => {})
const qwenSynthesizeMock = vi.fn(async () => ({
  audioBase64: 'QXdlbjM=',
  mediaType: 'audio/x-wav',
  speaker: 'Ryan',
  language: 'English',
  mode: 'custom_voice',
}))
const qwenApplyUserVoicePreferenceMock = vi.fn(async () => {})
const qwenSaveWavToDiskMock = vi.fn(async () => '/audio/clip.wav')

const transcribeAudioBufferMock = vi.fn(async () => 'buffer transcript')
const transcribeAudioBlobMock = vi.fn(async () => 'blob transcript')
const synthesizeSpeechMock = vi.fn(async (..._args: unknown[]) => ({
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: 'audio/wav',
}))
const bytesToBase64Mock = vi.fn(() => 'AQID')
const base64ToBytesMock = vi.fn(() => new Uint8Array([1, 2, 3]))
const bytesToBlobUrlMock = vi.fn(() => 'blob:fake-url')
const errorsReportMock = vi.fn()
const saveGeneratedAudioMock = vi.fn(async () => ({ success: true, filePath: '/audio/clip.wav' }))

vi.mock('@/assets/js/store/speechToText', () => ({
  useSpeechToText: () => ({
    effectiveSttEngine: sttEngine.value,
    available: sttAvailable.value,
    ensureWhisperReady: ensureWhisperReadyMock,
    ensureStandaloneReady: ensureStandaloneReadyMock,
    ensureStandaloneServerRunning: ensureStandaloneServerRunningMock,
    ensureTranscriptionServerRunning: ensureTranscriptionServerRunningMock,
    resolveTranscription: resolveTranscriptionMock,
  }),
}))
vi.mock('@/assets/js/store/textToSpeech', () => ({
  useTextToSpeech: () => ({
    selectedEngine: ttsEngine.value,
    available: ttsAvailable.value,
    isKokoroAvailable: ttsKokoroAvailable.value,
    isExternalAvailable: ttsExternalAvailable.value,
    ensureSpeechServerRunning: ensureSpeechServerRunningMock,
    resolveSpeech: resolveSpeechMock,
    synthesizeToWav: synthesizeToWavMock,
  }),
}))
vi.mock('@/assets/js/store/qwen3TextToSpeech', () => ({
  useQwen3TextToSpeech: () => ({
    isBackendSetUp: () => qwenBackendSetUp.value,
    isModelInstalled: qwenIsModelInstalledMock,
    isModelLoaded: qwenIsModelLoadedMock,
    ensureModelLoaded: qwenEnsureModelLoadedMock,
    synthesize: qwenSynthesizeMock,
    applyUserVoicePreference: qwenApplyUserVoicePreferenceMock,
    saveWavToDisk: qwenSaveWavToDiskMock,
  }),
}))
vi.mock('@/lib/transcribe', () => ({
  transcribeAudioBuffer: transcribeAudioBufferMock,
  transcribeAudioBlob: transcribeAudioBlobMock,
}))
vi.mock('@/lib/synthesizeSpeech', () => ({
  synthesizeSpeech: synthesizeSpeechMock,
  bytesToBase64: bytesToBase64Mock,
  bytesToBlobUrl: bytesToBlobUrlMock,
  base64ToBytes: base64ToBytesMock,
}))
vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReportMock }),
}))

// Imported late on purpose: a dynamic import runs in source order, so the
// hoisted factories only execute after the mock consts are initialized.
const {
  NO_TRANSCRIPTION_ENDPOINT,
  isSpeaking,
  pendingVoiceTurn,
  readyTranscriptionForInput,
  readyTranscriptionUnattended,
  saveSpeechClip,
  speak,
  speakRepliesAvailable,
  speakingMessageId,
  stopSpeaking,
  synthesizeClip,
  synthesizeToolAvailable,
  transcribe,
  transcriptionAvailable,
} = await import('@/assets/js/speech/speechIO')

/** A minimal RIFF/WAVE header so `transcribe` takes the no-re-encode path. */
function wavBlob(): Blob {
  const header = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
  return new Blob([header], { type: 'audio/wav' })
}

class FakeAudio {
  static last: FakeAudio | undefined
  play = vi.fn().mockResolvedValue(undefined)
  pause = vi.fn()
  src = ''
  onended: (() => void) | undefined
  onerror: (() => void) | undefined
  constructor() {
    FakeAudio.last = this
  }
}

describe('speechIO (Speech I/O adapter)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sttEngine.value = 'whisper'
    sttAvailable.value = true
    ttsEngine.value = 'qwen3'
    ttsAvailable.value = true
    ttsKokoroAvailable.value = true
    ttsExternalAvailable.value = true
    qwenBackendSetUp.value = true
    qwenModelLoaded.value = false
    resolveTranscriptionMock.mockResolvedValue({
      baseURL: 'http://localhost:29000/v3',
      model: 'whisper',
      apiKey: '',
    })
    resolveSpeechMock.mockResolvedValue({
      baseURL: 'http://localhost:29000/v3',
      model: 'kokoro',
      voice: 'af_heart',
      apiKey: '',
    })
    qwenIsModelInstalledMock.mockResolvedValue(true)
    vi.stubGlobal('window', { electronAPI: { saveGeneratedAudio: saveGeneratedAudioMock } })
    ;(globalThis as Record<string, unknown>).Audio = FakeAudio
    ;(globalThis.URL as typeof globalThis.URL & { revokeObjectURL?: unknown }).revokeObjectURL =
      vi.fn()
    stopSpeaking()
    pendingVoiceTurn.value = false
  })

  describe('STT readiness', () => {
    it('readies the OpenVINO engine interactively and reports its result', async () => {
      ensureWhisperReadyMock.mockResolvedValueOnce({ downloadPrompted: true })
      const ready = await readyTranscriptionForInput()
      expect(ensureWhisperReadyMock).toHaveBeenCalledTimes(1)
      expect(ensureStandaloneReadyMock).not.toHaveBeenCalled()
      expect(ready).toEqual({ downloadPrompted: true })
    })

    it('readies the standalone engine interactively', async () => {
      sttEngine.value = 'standalone'
      await readyTranscriptionForInput()
      expect(ensureStandaloneReadyMock).toHaveBeenCalledTimes(1)
      expect(ensureWhisperReadyMock).not.toHaveBeenCalled()
    })

    it('starts nothing for the external engine', async () => {
      sttEngine.value = 'external'
      const ready = await readyTranscriptionForInput()
      expect(ensureWhisperReadyMock).not.toHaveBeenCalled()
      expect(ensureStandaloneReadyMock).not.toHaveBeenCalled()
      expect(ready).toEqual({ downloadPrompted: false })
    })

    it('readies unattended standalone by starting the sidecar only', async () => {
      sttEngine.value = 'standalone'
      await readyTranscriptionUnattended()
      expect(ensureStandaloneServerRunningMock).toHaveBeenCalledTimes(1)
      expect(ensureTranscriptionServerRunningMock).not.toHaveBeenCalled()
    })

    it('readies unattended non-standalone engines through the OVMS server path', async () => {
      await readyTranscriptionUnattended()
      expect(ensureTranscriptionServerRunningMock).toHaveBeenCalledTimes(1)
      expect(ensureStandaloneServerRunningMock).not.toHaveBeenCalled()
    })

    it('exposes STT availability for the mic gate', () => {
      expect(transcriptionAvailable()).toBe(true)
      sttAvailable.value = false
      expect(transcriptionAvailable()).toBe(false)
    })
  })

  describe('transcribe', () => {
    it('sends WAV bytes straight to the resolved endpoint', async () => {
      const { text } = await transcribe({ audio: wavBlob() })
      expect(text).toBe('buffer transcript')
      expect(transcribeAudioBufferMock).toHaveBeenCalledTimes(1)
      expect(transcribeAudioBlobMock).not.toHaveBeenCalled()
      expect(resolveTranscriptionMock).toHaveBeenCalledTimes(1)
    })

    it('converts non-WAV audio before transcribing', async () => {
      const { text } = await transcribe({
        audio: new Blob(['not a wav'], { type: 'audio/webm' }),
      })
      expect(text).toBe('blob transcript')
      expect(transcribeAudioBlobMock).toHaveBeenCalledTimes(1)
      expect(transcribeAudioBufferMock).not.toHaveBeenCalled()
    })

    it('throws the shared no-endpoint error when nothing can serve', async () => {
      resolveTranscriptionMock.mockResolvedValueOnce(null)
      await expect(transcribe({ audio: wavBlob() })).rejects.toThrow(NO_TRANSCRIPTION_ENDPOINT)
      expect(transcribeAudioBufferMock).not.toHaveBeenCalled()
    })
  })

  describe('synthesizeClip (Qwen3)', () => {
    it('loads the model when not resident, then synthesizes with the voice request', async () => {
      const phases: string[] = []
      const clip = await synthesizeClip({
        text: 'hello',
        voice: {
          speaker: 'Ryan',
          language: 'English',
          mode: 'custom_voice',
          instruct: 'calm',
        },
        onPhase: (phase) => phases.push(phase),
      })
      expect(phases).toEqual(['loading-model', 'generating'])
      expect(qwenIsModelLoadedMock).toHaveBeenCalledWith('custom_voice')
      expect(qwenEnsureModelLoadedMock).toHaveBeenCalledWith('custom_voice')
      expect(qwenSynthesizeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'hello',
          speaker: 'Ryan',
          language: 'English',
          mode: 'custom_voice',
          instruct: 'calm',
        }),
      )
      expect(clip).toMatchObject({
        audioBase64: 'QXdlbjM=',
        mediaType: 'audio/x-wav',
        voice: 'Ryan',
        engine: 'qwen3',
        mode: 'custom_voice',
        language: 'English',
      })
      expect(qwenApplyUserVoicePreferenceMock).not.toHaveBeenCalled()
    })

    it('resolves a saved voice to the voice_design load mode', async () => {
      await synthesizeClip({ text: 'hi', voice: { voiceName: 'Tammy' } })
      expect(qwenIsModelLoadedMock).toHaveBeenCalledWith('voice_design')
      expect(qwenSynthesizeMock).toHaveBeenCalledWith(
        expect.objectContaining({ voiceName: 'Tammy' }),
      )
    })

    it('skips the model load when the engine reports it resident', async () => {
      qwenModelLoaded.value = true
      await synthesizeClip({ text: 'hello' })
      expect(qwenEnsureModelLoadedMock).not.toHaveBeenCalled()
      expect(qwenSynthesizeMock).toHaveBeenCalledTimes(1)
    })

    it('persists the default voice only when asked', async () => {
      await synthesizeClip({
        text: 'hello',
        voice: {
          speaker: 'Vivian',
          language: 'German',
          mode: 'custom_voice',
          rememberAsDefault: true,
        },
      })
      expect(qwenApplyUserVoicePreferenceMock).toHaveBeenCalledWith({
        speaker: 'Vivian',
        language: 'German',
        mode: 'custom_voice',
      })
    })

    it('bails out unattended when the backend is not installed', async () => {
      qwenBackendSetUp.value = false
      const clip = await synthesizeClip({ text: 'hello', unattended: true })
      expect(clip).toBeNull()
      expect(qwenSynthesizeMock).not.toHaveBeenCalled()
    })

    it('bails out unattended when the model is missing', async () => {
      qwenIsModelInstalledMock.mockResolvedValueOnce(false)
      const clip = await synthesizeClip({ text: 'hello', unattended: true })
      expect(clip).toBeNull()
      expect(qwenEnsureModelLoadedMock).not.toHaveBeenCalled()
      expect(qwenSynthesizeMock).not.toHaveBeenCalled()
    })
  })

  describe('synthesizeClip (Kokoro / external)', () => {
    it('synthesizes interactively through the selected engine', async () => {
      ttsEngine.value = 'kokoro'
      const phases: string[] = []
      const clip = await synthesizeClip({ text: 'hello', onPhase: (p) => phases.push(p) })
      expect(phases).toEqual(['generating'])
      expect(synthesizeToWavMock).toHaveBeenCalledWith('hello')
      expect(clip).toMatchObject({
        audioBase64: 'Tts9',
        mediaType: 'audio/wav',
        voice: 'af_heart',
        engine: 'kokoro',
      })
      expect(qwenSynthesizeMock).not.toHaveBeenCalled()
    })

    it('bails out unattended when no non-Qwen engine is available', async () => {
      ttsEngine.value = 'kokoro'
      ttsAvailable.value = false
      const clip = await synthesizeClip({ text: 'hello', unattended: true })
      expect(clip).toBeNull()
      expect(ensureSpeechServerRunningMock).not.toHaveBeenCalled()
      expect(synthesizeSpeechMock).not.toHaveBeenCalled()
    })

    it('synthesizes unattended via the dialog-free server start and WAV format', async () => {
      ttsEngine.value = 'kokoro'
      const clip = await synthesizeClip({ text: 'hello', unattended: true, format: 'wav' })
      expect(ensureSpeechServerRunningMock).toHaveBeenCalledTimes(1)
      expect(synthesizeSpeechMock).toHaveBeenCalledWith(
        'hello',
        expect.objectContaining({ baseURL: 'http://localhost:29000/v3' }),
        { format: 'wav' },
      )
      expect(clip).toMatchObject({
        audioBase64: 'AQID',
        mediaType: 'audio/wav',
        voice: 'af_heart',
        engine: 'kokoro',
      })
    })

    it('returns null unattended when no endpoint resolves', async () => {
      ttsEngine.value = 'kokoro'
      resolveSpeechMock.mockResolvedValueOnce(null)
      const clip = await synthesizeClip({ text: 'hello', unattended: true })
      expect(clip).toBeNull()
      expect(synthesizeSpeechMock).not.toHaveBeenCalled()
    })
  })

  describe('desktop playback (speak)', () => {
    it('synthesizes and plays the trimmed text, tracking the message', async () => {
      await speak({ text: '  hello there  ', messageId: 'msg-1' })
      expect(synthesizeSpeechMock).toHaveBeenCalledWith(
        'hello there',
        expect.objectContaining({ model: 'kokoro' }),
        undefined,
      )
      expect(bytesToBase64Mock).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
      expect(bytesToBlobUrlMock).toHaveBeenCalledWith(expect.any(Uint8Array), 'audio/wav')
      expect(isSpeaking.value).toBe(true)
      expect(speakingMessageId.value).toBe('msg-1')
      expect(FakeAudio.last?.play).toHaveBeenCalledTimes(1)
      FakeAudio.last?.onended?.()
      expect(isSpeaking.value).toBe(false)
      expect(speakingMessageId.value).toBe(null)
    })

    it('reports instead of playing when no endpoint resolves', async () => {
      resolveSpeechMock.mockResolvedValueOnce(null)
      await speak({ text: 'hello' })
      expect(errorsReportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'inference/tts-unavailable',
          userMessage: 'Text To Speech is not available (no OVMS server or fallback configured)',
        }),
      )
      expect(synthesizeSpeechMock).not.toHaveBeenCalled()
      expect(isSpeaking.value).toBe(false)
    })

    it('reports instead of playing when no playback engine is configured', async () => {
      ttsAvailable.value = false
      await speak({ text: 'hello' })
      expect(errorsReportMock).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'inference/tts-unavailable' }),
      )
      expect(ensureSpeechServerRunningMock).not.toHaveBeenCalled()
      expect(synthesizeSpeechMock).not.toHaveBeenCalled()
    })

    it('reports synthesis failures through the error sink and stops playback', async () => {
      synthesizeSpeechMock.mockRejectedValueOnce(new Error('server down'))
      await speak({ text: 'hello', messageId: 'msg-9' })
      expect(errorsReportMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ code: 'inference/tts-failed', surface: 'toast' }),
      )
      expect(isSpeaking.value).toBe(false)
      expect(speakingMessageId.value).toBe(null)
    })

    it('skips synthesis for empty text', async () => {
      await speak({ text: '   ' })
      expect(synthesizeSpeechMock).not.toHaveBeenCalled()
      expect(ensureSpeechServerRunningMock).not.toHaveBeenCalled()
    })

    it('reports reply-playback availability from the engine config', () => {
      expect(speakRepliesAvailable()).toBe(true)
      ttsAvailable.value = false
      expect(speakRepliesAvailable()).toBe(false)
    })
  })

  describe('tool gating and clip saving', () => {
    it('gates the synthesis tool on the selected engine being usable', () => {
      expect(synthesizeToolAvailable()).toBe(true)
      ttsEngine.value = 'kokoro'
      expect(synthesizeToolAvailable()).toBe(true)
      ttsKokoroAvailable.value = false
      expect(synthesizeToolAvailable()).toBe(false)
      ttsEngine.value = 'external'
      ttsExternalAvailable.value = false
      expect(synthesizeToolAvailable()).toBe(false)
    })

    it('saves a clip through the engine-agnostic persistence IPC, not the Qwen3 store', async () => {
      const path = await saveSpeechClip('QXdlbjM=', 'clip.wav')
      expect(saveGeneratedAudioMock).toHaveBeenCalledWith('QXdlbjM=', 'clip.wav', undefined)
      expect(path).toBe('/audio/clip.wav')
      expect(qwenSaveWavToDiskMock).not.toHaveBeenCalled()
    })
  })
})
