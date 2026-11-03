import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioTurnRequest } from '@/types/sessionIpc'

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { createSession, openSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { recordAudioTurn } = await import('../../session/sessionAudioTurn')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-audio-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
})

const WAV = Buffer.from('RIFF fake wav bytes').toString('base64')

function tts(sessionId: string, overrides: Partial<AudioTurnRequest> = {}): AudioTurnRequest {
  return {
    sessionId,
    kind: 'tts',
    preset: 'Text to Speech',
    prompt: 'Hello there, general Kenobi',
    status: 'completed',
    engine: 'Kokoro',
    audio: { base64: WAV, fileName: 'tts-hello.wav' },
    ...overrides,
  }
}

function stt(sessionId: string, overrides: Partial<AudioTurnRequest> = {}): AudioTurnRequest {
  return {
    sessionId,
    kind: 'stt',
    preset: 'Speech to Text',
    prompt: '🎤 meeting.wav',
    status: 'completed',
    transcript: 'Let us begin the meeting.',
    engine: 'Whisper',
    audio: { base64: WAV, fileName: 'meeting.wav' },
    ...overrides,
  }
}

const filesOf = (id: string) => fs.readdir(path.join(dirs.real, id, 'files'))

describe('an audio turn in a Session', () => {
  it('saves the synthesized clip into files/ and records a tts History Entry', async () => {
    const { id } = await createSession()

    await recordAudioTurn(tts(id))

    expect(await filesOf(id)).toEqual(['tts-hello.wav'])
    expect(await fs.readFile(path.join(dirs.real, id, 'files', 'tts-hello.wav'))).toEqual(
      Buffer.from(WAV, 'base64'),
    )
    expect(await readHistoryEntries(id)).toEqual([
      expect.objectContaining({
        preset: 'Text to Speech',
        kind: 'tts',
        prompt: 'Hello there, general Kenobi',
        status: 'completed',
        artifacts: [{ path: 'files/tts-hello.wav', mediaType: 'audio' }],
      }),
    ])
  })

  it('records an stt turn with the transcript as response and the source audio as artifact', async () => {
    const { id } = await createSession()

    await recordAudioTurn(stt(id))

    expect(await filesOf(id)).toEqual(['meeting.wav'])
    const [entry] = await readHistoryEntries(id)
    expect(entry).toEqual(
      expect.objectContaining({
        kind: 'stt',
        prompt: '🎤 meeting.wav',
        response: 'Let us begin the meeting.',
        artifacts: [{ path: 'files/meeting.wav', mediaType: 'audio' }],
      }),
    )
  })

  it('records a failed synthesis with no artifact', async () => {
    const { id } = await createSession()

    await recordAudioTurn(tts(id, { status: 'failed', error: 'device lost', audio: undefined }))

    expect(await readHistoryEntries(id)).toEqual([
      expect.objectContaining({ kind: 'tts', status: 'failed', artifacts: [] }),
    ])
  })

  it('never overwrites a file already in files/', async () => {
    const { id } = await createSession()
    await recordAudioTurn(tts(id))
    await recordAudioTurn(tts(id))

    expect((await filesOf(id)).sort()).toEqual(['tts-hello-1.wav', 'tts-hello.wav'])
  })

  it('keeps a hostile file name inside files/', async () => {
    const { id } = await createSession()
    await recordAudioTurn(stt(id, { audio: { base64: WAV, fileName: '../../escape.wav' } }))

    expect(await filesOf(id)).toEqual(['escape.wav'])
    expect(await fs.readdir(dirs.real)).toEqual([id])
  })

  it('adds the prompt and an audio result to the timeline and returns the Session', async () => {
    const { id } = await createSession()
    await recordAudioTurn(tts(id))
    const document = await recordAudioTurn(stt(id))

    const { timeline } = await openSession(id)
    expect(document.timeline).toEqual(timeline)
    expect(timeline).toEqual([
      expect.objectContaining({
        role: 'user',
        parts: [{ type: 'text', text: 'Hello there, general Kenobi' }],
      }),
      expect.objectContaining({
        role: 'assistant',
        parts: [
          {
            type: 'data-audio',
            data: expect.objectContaining({
              kind: 'tts',
              status: 'completed',
              engine: 'Kokoro',
              audioUrl: `aipg-media://sessions/${id}/files/tts-hello.wav`,
            }),
          },
        ],
      }),
      expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: '🎤 meeting.wav' }] }),
      expect.objectContaining({
        role: 'assistant',
        parts: [
          {
            type: 'data-audio',
            data: expect.objectContaining({
              kind: 'stt',
              transcript: 'Let us begin the meeting.',
              audioUrl: `aipg-media://sessions/${id}/files/meeting.wav`,
            }),
          },
        ],
      }),
    ])
  })

  it('titles the Session with the spoken text, or with the transcript for stt', async () => {
    const first = await createSession()
    await recordAudioTurn(tts(first.id))
    expect((await openSession(first.id)).title).toBe('Hello there, general Kenobi')

    const second = await createSession()
    await recordAudioTurn(stt(second.id))
    const session = await openSession(second.id)
    expect(session.title).toBe('Let us begin the meeting.')
    expect(session.presetsUsed).toEqual(['Speech to Text'])
  })
})
