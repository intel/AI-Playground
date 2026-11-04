import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The audio turn driver against the real Session module in a temp dir; only the
// speech engines are faked.

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))
const speech = vi.hoisted(() => ({
  synthesizeClip: vi.fn(),
  transcribe: vi.fn(),
  readyTranscriptionForInput: vi.fn(),
}))
const activePreset = vi.hoisted(() => ({ name: 'Text to Speech' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/assets/js/toast', () => ({
  show: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/assets/js/speech/speechIO', () => speech)

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
}))

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    get activePresetName() {
      return activePreset.name
    },
  }),
}))

const sessionModule = await import('../../session/sessions')
const kernelBus = await import('../../kernel/kernelBus')
const { recordAudioTurn } = await import('../../session/sessionAudioTurn')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const ledger = await import('../../session/sessionTurns')
const { useSessions } = await import('@/assets/js/store/sessions')
const { useSessionAudio } = await import('@/assets/js/store/sessionAudio')

const WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3])

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-audio-store-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  sessionModule.setSessionDeps({ isDemoMode: () => false })
  kernelBus.resetKernelBusForTest()
  ledger.resetSessionTurnsForTest()
  speech.synthesizeClip.mockReset()
  speech.transcribe.mockReset()
  speech.readyTranscriptionForInput.mockReset().mockResolvedValue({ ready: true })
  activePreset.name = 'Text to Speech'
  vi.stubGlobal('window', {
    electronAPI: {
      onKernelEvent: kernelBus.onKernelEvent,
      getKernelSnapshot: async () => kernelBus.getKernelSnapshot(),
      sessions: {
        list: async () => ({
          success: true,
          sessions: await sessionModule.listSessions(),
          groups: await sessionModule.listSessionGroups(),
          pinnedShowMore: await sessionModule.readPinnedShowMore(),
        }),
        create: async () => ({ success: true, session: await sessionModule.createSession() }),
        open: async (id: string) => ({
          success: true,
          session: await sessionModule.openSession(id),
        }),
        recordAudioTurn: async (turn: Parameters<typeof recordAudioTurn>[0]) => ({
          success: true,
          session: await recordAudioTurn(structuredClone(turn)),
        }),
        beginTurn: async (id: string, turn: Parameters<typeof ledger.claimSessionTurn>[1]) =>
          ledger.claimSessionTurn(id, turn)
            ? { success: true }
            : { success: false, error: ledger.SESSION_BUSY_MESSAGE },
        endTurn: async (id: string, turnId: string) => {
          ledger.releaseSessionTurn(id, turnId)
          return { success: true }
        },
      },
    },
  })
  setActivePinia(createPinia())
})

afterEach(async () => {
  vi.unstubAllGlobals()
  sessionModule.resetSessionsForTest()
  await fs.rm(path.dirname(dirs.real), { recursive: true, force: true })
})

async function openSession() {
  const sessions = useSessions()
  await sessions.init()
  return { sessions, id: sessions.openSessionId! }
}

describe('Text-to-Speech in a Session', () => {
  it('saves the clip into the open Session and shows the turn', async () => {
    const { sessions, id } = await openSession()
    speech.synthesizeClip.mockResolvedValue({
      audioBase64: Buffer.from(WAV_BYTES).toString('base64'),
      mediaType: 'audio/wav',
      voice: 'af_heart',
      engine: 'kokoro',
    })

    await useSessionAudio().synthesize('Read this aloud')

    const [entry] = await readHistoryEntries(id)
    expect(entry).toEqual(
      expect.objectContaining({ kind: 'tts', prompt: 'Read this aloud', status: 'completed' }),
    )
    const saved = path.join(dirs.real, id, entry.artifacts[0].path)
    expect(new Uint8Array(await fs.readFile(saved))).toEqual(WAV_BYTES)
    expect(sessions.openTimeline).toHaveLength(2)
    expect(sessions.openSession?.title).toBe('Read this aloud')
  })

  it('records a failed synthesis as a failed turn', async () => {
    const { id } = await openSession()
    speech.synthesizeClip.mockRejectedValue(new Error('UR_RESULT_ERROR_DEVICE_LOST'))

    await useSessionAudio().synthesize('Read this aloud')

    expect(await readHistoryEntries(id)).toEqual([
      expect.objectContaining({ kind: 'tts', status: 'failed', artifacts: [] }),
    ])
  })

  it('is busy for the open Session while synthesizing', async () => {
    await openSession()
    let finish: (value: unknown) => void = () => {}
    speech.synthesizeClip.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const audio = useSessionAudio()

    const running = audio.synthesize('Read this aloud')
    await vi.waitFor(() => expect(audio.processing).toBe(true))
    expect(audio.pendingTurn?.prompt).toBe('Read this aloud')
    finish({ audioBase64: 'AAAA', mediaType: 'audio/wav', voice: 'v', engine: 'qwen3' })
    await running

    expect(audio.processing).toBe(false)
  })

  it('holds the open Session as its one turn, and refuses to start while another holds it', async () => {
    const { sessions, id } = await openSession()
    let finish: (value: unknown) => void = () => {}
    speech.synthesizeClip.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const audio = useSessionAudio()

    const running = audio.synthesize('Read this aloud')
    await vi.waitFor(() => expect(sessions.openTurn?.kind).toBe('audio'))
    finish({ audioBase64: 'AAAA', mediaType: 'audio/wav', voice: 'v', engine: 'qwen3' })
    await running
    await vi.waitFor(() => expect(sessions.openTurn).toBeNull())

    ledger.claimSessionTurn(id, { turnId: 'agent-turn', kind: 'agent' })
    await audio.synthesize('Not now')
    expect(speech.synthesizeClip).toHaveBeenCalledTimes(1)
    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual(['Read this aloud'])
  })
})

describe('Speech-to-Text in a Session', () => {
  it('records the transcript and keeps the source audio in files/', async () => {
    activePreset.name = 'Speech to Text'
    const { sessions, id } = await openSession()
    speech.transcribe.mockResolvedValue({ text: 'Hello from the microphone' })

    await useSessionAudio().transcribeAudio(new Blob([WAV_BYTES], { type: 'audio/wav' }), {
      label: '🎤 Recording',
    })

    const [entry] = await readHistoryEntries(id)
    expect(entry).toEqual(
      expect.objectContaining({
        preset: 'Speech to Text',
        kind: 'stt',
        prompt: '🎤 Recording',
        response: 'Hello from the microphone',
        status: 'completed',
        artifacts: [expect.objectContaining({ mediaType: 'audio' })],
      }),
    )
    const saved = path.join(dirs.real, id, entry.artifacts[0].path)
    expect(new Uint8Array(await fs.readFile(saved))).toEqual(WAV_BYTES)
    expect(sessions.openSession?.title).toBe('Hello from the microphone')
  })

  it('names an uploaded clip after its file', async () => {
    activePreset.name = 'Speech to Text'
    const { id } = await openSession()
    speech.transcribe.mockResolvedValue({ text: 'minutes' })

    await useSessionAudio().transcribeAudio(new Blob([WAV_BYTES]), {
      label: '🎤 standup.wav',
      fileName: 'standup.wav',
    })

    const [entry] = await readHistoryEntries(id)
    expect(entry.artifacts).toEqual([{ path: 'files/standup.wav', mediaType: 'audio' }])
  })

  it('settles silence as a failed turn that still keeps the source audio', async () => {
    activePreset.name = 'Speech to Text'
    const { id } = await openSession()
    speech.transcribe.mockResolvedValue({ text: '   ' })

    await useSessionAudio().transcribeAudio(new Blob([WAV_BYTES]), { label: '🎤 Recording' })

    const [entry] = await readHistoryEntries(id)
    expect(entry).toEqual(expect.objectContaining({ kind: 'stt', status: 'failed' }))
    expect(entry.response).toBeUndefined()
    expect(entry.artifacts).toHaveLength(1)
  })
})
