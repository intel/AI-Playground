import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SESSION_FILES_DIR } from '../persist/sessionFiles'
import { appendHistoryEntry } from './sessionHistory'
import { appendTurnToTimeline, freeName } from './sessionMediaTurn'
import { sessionPaths } from './sessions'
import { sessionMediaUrl } from '@/lib/comfyWorkflow'
import type { AudioTurnRequest, SessionDocument } from '@/types/sessionIpc'
import type { TimelineMessage } from '@/types/sessionTimeline'

function safeAudioName(fileName: string): string {
  const base = path.basename(fileName.replace(/\\/g, '/'))
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '')
  const named = cleaned || `audio-${Date.now()}`
  return path.extname(named) ? named : `${named}.wav`
}

async function saveIntoFiles(
  sessionId: string,
  audio: NonNullable<AudioTurnRequest['audio']>,
): Promise<string> {
  const filesDir = sessionPaths(sessionId).filesDir
  await fs.mkdir(filesDir, { recursive: true })
  const name = await freeName(filesDir, safeAudioName(audio.fileName))
  await fs.writeFile(path.join(filesDir, name), Buffer.from(audio.base64, 'base64'), {
    flag: 'wx',
  })
  return `${SESSION_FILES_DIR}/${name}`
}

/**
 * Settles one Text-to-Speech or Speech-to-Text turn into its Session: the audio
 * (TTS output, STT source) is written into `files/`, one History Entry is
 * appended, and the prompt plus an audio result join the display timeline.
 */
export async function recordAudioTurn(turn: AudioTurnRequest): Promise<SessionDocument> {
  const relativePath = turn.audio ? await saveIntoFiles(turn.sessionId, turn.audio) : undefined

  await appendHistoryEntry(turn.sessionId, {
    preset: turn.preset,
    kind: turn.kind,
    prompt: turn.prompt,
    status: turn.status,
    response: turn.transcript,
    artifacts: relativePath ? [{ path: relativePath, mediaType: 'audio' }] : [],
  })

  const now = Date.now()
  const messages: TimelineMessage[] = [
    {
      id: `msg-${randomUUID()}`,
      role: 'user',
      createdAt: now,
      parts: [{ type: 'text', text: turn.prompt }],
    },
    {
      id: `msg-${randomUUID()}`,
      role: 'assistant',
      createdAt: now,
      parts: [
        {
          type: 'data-audio',
          data: {
            kind: turn.kind,
            preset: turn.preset,
            status: turn.status,
            error: turn.error,
            audioUrl: relativePath ? sessionMediaUrl(turn.sessionId, relativePath) : undefined,
            transcript: turn.transcript,
            engine: turn.engine,
          },
        },
      ],
    },
  ]
  return appendTurnToTimeline(turn.sessionId, {
    preset: turn.preset,
    titleSource: (turn.kind === 'stt' && turn.transcript) || turn.prompt,
    messages,
    at: now,
  })
}
