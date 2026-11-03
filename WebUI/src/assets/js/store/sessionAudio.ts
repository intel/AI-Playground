import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { usePresets } from '@/assets/js/store/presets'
import { useSessions } from '@/assets/js/store/sessions'
import { isCancellation } from '@/assets/js/errors/appError'
import {
  readyTranscriptionForInput,
  synthesizeClip,
  transcribe,
  type SpeechClipResult,
} from '@/assets/js/speech/speechIO'
import { bytesToBase64 } from '@/lib/synthesizeSpeech'
import { formatTtsAudioTimestamp } from '@/lib/ttsAudioFileName'
import type { AudioTurnRequest } from '@/types/sessionIpc'

export type AudioTurnPhase = 'loading-model' | 'generating' | 'transcribing'

/** A Text-to-Speech / Speech-to-Text turn still running in a Session. */
export type PendingAudioTurn = {
  kind: AudioTurnRequest['kind']
  preset: string
  prompt: string
  createdAt: number
  phase: AudioTurnPhase
}

const NO_SPEECH = "Couldn't make out any speech in that audio."

const ENGINE_LABEL: Record<SpeechClipResult['engine'], string> = {
  qwen3: 'Qwen TTS',
  kokoro: 'Kokoro',
  external: 'External TTS',
}

function extensionOf(mediaType: string | undefined): string {
  const subtype = mediaType?.split('/')[1]?.split(';')[0]?.trim()
  if (!subtype || ['wav', 'x-wav', 'wave', 'vnd.wave'].includes(subtype)) return 'wav'
  return subtype === 'mpeg' ? 'mp3' : subtype
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function base64Of(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

/** Runs the Audio presets' turns inside the open Session and settles each one into it. */
export const useSessionAudio = defineStore('sessionAudio', () => {
  const sessions = useSessions()
  const presets = usePresets()
  const errors = useErrors()
  const i18nState = useI18N().state

  const pendingTurns = ref<Record<string, PendingAudioTurn>>({})

  const pendingTurn = computed(() =>
    sessions.openSessionId ? (pendingTurns.value[sessions.openSessionId] ?? null) : null,
  )
  const processing = computed(() => pendingTurn.value !== null)

  function setPhase(sessionId: string, phase: AudioTurnPhase): void {
    const turn = pendingTurns.value[sessionId]
    if (turn) pendingTurns.value = { ...pendingTurns.value, [sessionId]: { ...turn, phase } }
  }

  /** Opens the turn in the open Session; null when there is none or it is already busy. */
  async function begin(
    turn: Omit<PendingAudioTurn, 'preset' | 'createdAt'>,
  ): Promise<{ sessionId: string; preset: string } | null> {
    const sessionId = await sessions.ensureOpenSession()
    if (!sessionId || pendingTurns.value[sessionId]) return null
    const preset = presets.activePresetName ?? ''
    const turnId = crypto.randomUUID()
    try {
      const claimed = await window.electronAPI.sessions.beginTurn(sessionId, {
        turnId,
        kind: 'audio',
        presetName: preset,
      })
      if (!claimed.success) throw new Error(claimed.error)
    } catch (error) {
      errors.report(error, {
        category: 'validation',
        code: 'sessions/turn-refused',
        surface: 'toast',
      })
      return null
    }
    pendingTurns.value = {
      ...pendingTurns.value,
      [sessionId]: { ...turn, preset, createdAt: Date.now() },
    }
    turnIds[sessionId] = turnId
    return { sessionId, preset }
  }

  const turnIds: Record<string, string> = {}

  function end(sessionId: string): void {
    const { [sessionId]: _ended, ...rest } = pendingTurns.value
    pendingTurns.value = rest
    const turnId = turnIds[sessionId]
    delete turnIds[sessionId]
    if (turnId) {
      void window.electronAPI.sessions
        .endTurn(sessionId, turnId)
        .catch((error: unknown) => errors.report(error, { surface: 'silent' }))
    }
  }

  async function settle(request: AudioTurnRequest): Promise<void> {
    try {
      const result = await window.electronAPI.sessions.recordAudioTurn(request)
      if (!result.success) throw new Error(result.error)
    } catch (error) {
      errors.report(error, {
        category: 'backend',
        code: 'sessions/record-audio-failed',
        userMessage: i18nState.SESSION_AUDIO_TURN_NOT_SAVED,
        surface: 'toast',
      })
    }
  }

  async function synthesize(text: string): Promise<void> {
    const prompt = text.trim()
    if (!prompt) return
    const started = await begin({ kind: 'tts', prompt, phase: 'loading-model' })
    if (!started) return
    const { sessionId, preset } = started
    const base = { sessionId, kind: 'tts' as const, preset, prompt }
    try {
      let request: AudioTurnRequest
      try {
        const clip = await synthesizeClip({
          text: prompt,
          onPhase: (phase) => setPhase(sessionId, phase),
        })
        request = {
          ...base,
          status: 'completed',
          engine: ENGINE_LABEL[clip.engine],
          audio: {
            base64: clip.audioBase64,
            fileName: `tts_${formatTtsAudioTimestamp(new Date())}.${extensionOf(clip.mediaType)}`,
          },
        }
      } catch (error) {
        if (isCancellation(error)) {
          request = { ...base, status: 'cancelled' }
        } else {
          errors.report(error, {
            category: 'inference',
            code: 'inference/tts-failed',
            userMessage: `Text To Speech failed: ${messageOf(error)}`,
            surface: 'toast',
          })
          request = { ...base, status: 'failed', error: messageOf(error) }
        }
      }
      await settle(request)
    } finally {
      end(sessionId)
    }
  }

  /** Transcribes an uploaded or recorded clip; the clip itself is kept in the Session. */
  async function transcribeAudio(
    blob: Blob,
    source: { label: string; fileName?: string },
  ): Promise<void> {
    const started = await begin({ kind: 'stt', prompt: source.label, phase: 'transcribing' })
    if (!started) return
    const { sessionId, preset } = started
    const base = { sessionId, kind: 'stt' as const, preset, prompt: source.label }
    try {
      const audio = {
        base64: await base64Of(blob),
        fileName:
          source.fileName ??
          `recording_${formatTtsAudioTimestamp(new Date())}.${extensionOf(blob.type)}`,
      }
      let request: AudioTurnRequest
      try {
        await readyTranscriptionForInput()
        const { text } = await transcribe({ audio: blob })
        const transcript = text.trim()
        request = transcript
          ? { ...base, status: 'completed', engine: 'Whisper', transcript, audio }
          : { ...base, status: 'failed', error: NO_SPEECH, audio }
      } catch (error) {
        if (isCancellation(error)) {
          request = { ...base, status: 'cancelled', audio }
        } else {
          errors.report(error, {
            category: 'inference',
            code: 'inference/stt-failed',
            userMessage: `Speech To Text failed: ${messageOf(error)}`,
            surface: 'toast',
          })
          request = { ...base, status: 'failed', error: messageOf(error), audio }
        }
      }
      await settle(request)
    } finally {
      end(sessionId)
    }
  }

  return { pendingTurns, pendingTurn, processing, synthesize, transcribeAudio }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessionAudio, import.meta.hot))
}
