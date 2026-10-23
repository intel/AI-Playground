import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Speech-to-text and text-to-speech each offer an "external" engine: a configurable
// OpenAI-compatible endpoint as an alternative to the OVMS servers. It exists for
// hosts where OVMS cannot serve them at all — notably macOS, where the OVMS binary
// is installed but not executable, so starting it fails with ENOEXEC while the
// service still reports isSetUp. These tests pin the resulting rule: once the
// external engine is selected, it is the source, and nothing local is started,
// downloaded or required.

const startTranscriptionServer = vi.fn(async () => {
  throw new Error('spawn ENOEXEC')
})
const stopTranscriptionServer = vi.fn(async () => {})
const startSpeechServer = vi.fn(async () => {
  throw new Error('spawn ENOEXEC')
})
const stopSpeechServer = vi.fn(async () => {})
const getTranscriptionServerUrl = vi.fn(async (): Promise<string | null> => null)
const getSpeechServerUrl = vi.fn(async (): Promise<string | null> => null)

// An OVMS that looks perfectly healthy from the renderer's side: installed and
// running. On macOS this is exactly the state in which its servers cannot start.
vi.mock('@/assets/js/store/backendServices', () => ({
  useBackendServices: () => ({
    info: [{ serviceName: 'openvino-backend', isSetUp: true, status: 'running' }],
    startTranscriptionServer,
    stopTranscriptionServer,
    getTranscriptionServerUrl,
    startSpeechServer,
    stopSpeechServer,
    getSpeechServerUrl,
  }),
}))

const checkTranscriptionModelExists = vi.fn(async () => false)
const checkSpeechModelExists = vi.fn(async () => false)

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({
    checkTranscriptionModelExists,
    checkSpeechModelExists,
    getMissingTranscriptionModel: vi.fn(async () => []),
    getMissingSpeechModel: vi.fn(async () => []),
  }),
}))

const requestDownload = vi.fn(async () => {})
const notify = vi.fn()

// The speech stores reach every prompt through the permissions layer now;
// asserting on it (rather than the dialog store) is what proves no prompt
// fires on the fallback paths.
vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload,
  notify,
  requestVramWarning: vi.fn(),
  REMOTE_DOWNLOAD_GRANT: 'download:remote-turns',
  vramWarningGrantKey: (presetName: string) => `vram-warning:${presetName}`,
}))

vi.mock('@/assets/js/store/setupWizard', () => ({
  useSetupWizard: () => ({ openWizard: vi.fn() }),
}))

vi.mock('@/assets/js/store/productMode', () => ({
  useProductMode: () => ({ isNvidiaModeSelected: false }),
}))

vi.mock('@/assets/js/toast', () => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))

vi.mock('@/assets/js/demoAwareStorage', () => ({
  demoAwareStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getTranscriptionServerUrl.mockResolvedValue(null)
  getSpeechServerUrl.mockResolvedValue(null)
})

describe('speech-to-text on the external engine', () => {
  async function sttOnExternal() {
    const { useSpeechToText } = await import('@/assets/js/store/speechToText')
    const stt = useSpeechToText()
    stt.fallback = { enabled: true, baseUrl: 'http://127.0.0.1:2022/v1', model: '', apiKey: 'k' }
    stt.selectedSttEngine = 'external'
    return stt
  }

  it('resolves to the external endpoint even when an OVMS server is up', async () => {
    getTranscriptionServerUrl.mockResolvedValue('http://127.0.0.1:29200/v3')
    const stt = await sttOnExternal()

    expect(await stt.resolveTranscription()).toEqual({
      baseURL: 'http://127.0.0.1:2022/v1',
      model: 'whisper-1',
      apiKey: 'k',
    })
    expect(getTranscriptionServerUrl).not.toHaveBeenCalled()
  })

  it('starts no OVMS server, even though OVMS reports itself installed', async () => {
    const stt = await sttOnExternal()

    await stt.ensureTranscriptionServerRunning()

    expect(startTranscriptionServer).not.toHaveBeenCalled()
  })

  it('needs no Whisper model', async () => {
    const stt = await sttOnExternal()

    await stt.ensureTranscriptionServerRunning()

    expect(checkTranscriptionModelExists).not.toHaveBeenCalled()
  })

  it('leaves OVMS alone on startup', async () => {
    const stt = await sttOnExternal()
    stt.enabled = true

    await stt.initialize()

    expect(stt.enabled).toBe(true)
    expect(startTranscriptionServer).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(requestDownload).not.toHaveBeenCalled()
  })

  it('still uses OVMS when the OpenVINO Whisper engine is selected', async () => {
    const { useSpeechToText } = await import('@/assets/js/store/speechToText')
    const stt = useSpeechToText()
    stt.selectedSttEngine = 'whisper'

    await stt.ensureTranscriptionServerRunning()

    // OVMS is installed here, so it gets as far as looking for the model.
    expect(checkTranscriptionModelExists).toHaveBeenCalled()
  })
})

describe('text-to-speech on the external engine', () => {
  async function ttsOnExternal() {
    const { useTextToSpeech } = await import('@/assets/js/store/textToSpeech')
    const tts = useTextToSpeech()
    tts.fallback = {
      enabled: true,
      baseUrl: 'http://127.0.0.1:2022/v1',
      model: '',
      voice: '',
      apiKey: 'k',
    }
    tts.selectedEngine = 'external'
    return tts
  }

  it('starts no OVMS server and needs no speech model', async () => {
    const tts = await ttsOnExternal()

    await tts.ensureSpeechServerRunning()

    expect(startSpeechServer).not.toHaveBeenCalled()
    expect(checkSpeechModelExists).not.toHaveBeenCalled()
  })

  it('leaves OVMS alone on startup', async () => {
    const tts = await ttsOnExternal()
    tts.enabled = true

    await tts.initialize()

    expect(tts.enabled).toBe(true)
    expect(startSpeechServer).not.toHaveBeenCalled()
  })
})
