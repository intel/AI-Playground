import { computed, ref } from 'vue'
import { useSpeechToText, type SttReadyResult } from '../store/speechToText'
import { useTextToSpeech } from '../store/textToSpeech'
import { useQwen3TextToSpeech } from '../store/qwen3TextToSpeech'
import { useErrors } from '../store/errors'
import { createAppError } from '../errors/appError'
import { transcribeAudioBlob, transcribeAudioBuffer } from '@/lib/transcribe'
import {
  base64ToBytes,
  bytesToBase64,
  bytesToBlobUrl,
  synthesizeSpeech,
} from '@/lib/synthesizeSpeech'
import { markdownToSpeechText } from '@/lib/markdownToSpeech'
import type {
  Qwen3TtsLanguage,
  Qwen3TtsSpeakerId,
  Qwen3TtsSynthesisMode,
} from '@/assets/js/qwen3TtsConstants'

/**
 * Speech I/O adapter — the one engine seam every speech driver crosses (§4.2
 * of docs/architecture-target.md): the mic and STT preset, the `transcribeAudio`
 * tool, "Speak replies" and the Speak button, the `synthesizeTextToSpeech`
 * tool, and the Home Agent voice paths. Engine selection, readiness, endpoint
 * resolution and the engine clients (Whisper OVMS / standalone sidecar /
 * external, Qwen3-TTS / Kokoro / external) live behind this module; drivers
 * must not import the TTS/STT stores or branch on the engine themselves.
 *
 * Engine config and the clients themselves stay in the stores for now
 * (`speechToText`, `textToSpeech`, `qwen3TextToSpeech`) — settings panels read
 * them directly. This module is the renderer interim of the target's
 * `SpeechIO`; it moves to main with the rest of the kernel in later steps.
 */

export type { SttReadyResult } from '../store/speechToText'

export type TranscriptResult = { text: string }

export type SpeechClipResult = {
  /** WAV/other audio payload, base64 — ready for disk or channel transport. */
  audioBase64: string
  /** MIME type of the payload (default `audio/wav`). */
  mediaType: string
  /** The voice actually used — the external engine may override the selection. */
  voice: string
  /** Which engine produced the clip; drivers shape their result text from this. */
  engine: 'qwen3' | 'kokoro' | 'external'
  /** Qwen3 only: the mode that actually ran, including `voice_clone`. */
  mode?: Qwen3TtsSynthesisMode
  /** Qwen3 only: the language the sidecar reports. */
  language?: string
}

/** Error message `transcribe` throws when no STT endpoint can be resolved. */
export const NO_TRANSCRIPTION_ENDPOINT =
  'Speech To Text is not available (no OVMS server or fallback configured).'

export type SpeechVoiceRequest = {
  /** Preset speaker id (Qwen3 custom_voice) — validated by the tool's enum. */
  speaker?: string
  language?: string
  mode?: Qwen3TtsSynthesisMode
  /** Natural-language voice description (voice_design) or speaking-style hint. */
  instruct?: string
  /** Name of one of the user's saved voices; overrides speaker/mode/instruct. */
  voiceName?: string
  seed?: number
  designNewVoice?: boolean
  /** Qwen3 only: persist speaker/language/mode as the user's defaults. */
  rememberAsDefault?: boolean
}

export type SynthesizeClipRequest = {
  text: string
  voice?: SpeechVoiceRequest
  /**
   * Unattended callers (Home Agent channels): never prompt a download; return
   * `null` instead when the engine's prerequisites (installed backend, model
   * on disk, configured endpoint) are missing.
   */
  unattended?: boolean
  /** Channels transcode to Opus and need universally-supported WAV. */
  format?: 'wav'
  /** Engine phase signal for activity-driven callers (the TTS tool). */
  onPhase?: (phase: 'loading-model' | 'generating') => void
}

/**
 * Interactive STT readiness — may prompt the model-download dialog on first
 * use. Callers that were about to *start* something on the user's behalf (the
 * mic button) must treat `downloadPrompted` as "this click went to the
 * download, ask the user to click again"; callers that only transcribe
 * already-captured audio (the tool, the STT preset upload) can ignore it.
 */
export async function readyTranscriptionForInput(): Promise<SttReadyResult> {
  const speechToText = useSpeechToText()
  if (speechToText.effectiveSttEngine === 'whisper') return speechToText.ensureWhisperReady()
  if (speechToText.effectiveSttEngine === 'standalone') return speechToText.ensureStandaloneReady()
  return { downloadPrompted: false }
}

/**
 * Unattended STT readiness — starts the selected engine's server when it is
 * installed and its model is already on disk, and never prompts (a remote
 * sender cannot answer a download popup on the host).
 */
export async function readyTranscriptionUnattended(): Promise<void> {
  const speechToText = useSpeechToText()
  // The standalone sidecar resolves its endpoint from the registered service's
  // baseUrl whether or not the process is running, so it needs the explicit
  // start; every other engine's resolver checks liveness itself.
  if (speechToText.effectiveSttEngine === 'standalone') {
    return speechToText.ensureStandaloneServerRunning()
  }
  return speechToText.ensureTranscriptionServerRunning()
}

/** Whether any STT engine is usable (OpenVINO Whisper, the standalone sidecar
 *  or a configured external endpoint) — the mic-button gate. */
export function transcriptionAvailable(): boolean {
  return useSpeechToText().available
}

/** Whether TTS can serve a synthesis right now: the selected engine must be
 *  Qwen3 (backend set up) or Kokoro/external (available). Gates offering the
 *  synthesizeTextToSpeech tool. */
export function synthesizeToolAvailable(): boolean {
  const tts = useTextToSpeech()
  if (tts.selectedEngine === 'kokoro') return tts.isKokoroAvailable
  if (tts.selectedEngine === 'external') return tts.isExternalAvailable
  return useQwen3TextToSpeech().isBackendSetUp()
}

/**
 * Transcribe an audio blob through the endpoint of the selected engine. WAV
 * input goes to the server unconverted; anything else (webm, ogg/opus, mp3 …)
 * is converted first. Throws (with {@link NO_TRANSCRIPTION_ENDPOINT}) when no
 * endpoint can be resolved — read `readyTranscriptionForInput` /
 * `readyTranscriptionUnattended` first; the external engine needs nothing.
 */
export async function transcribe(req: { audio: Blob }): Promise<TranscriptResult> {
  const speechToText = useSpeechToText()
  const endpoint = await speechToText.resolveTranscription()
  if (!endpoint) throw new Error(NO_TRANSCRIPTION_ENDPOINT)

  // WAV bytes go straight to the server; convertToWav would decode and
  // re-encode a perfectly good WAV (and the mic's blob is always WAV).
  const buffer = await req.audio.arrayBuffer()
  const isWav =
    buffer.byteLength > 11 &&
    new DataView(buffer).getUint32(0) === 0x52494646 && // 'RIFF'
    new DataView(buffer).getUint32(8) === 0x57415645 // 'WAVE'
  const text = isWav
    ? await transcribeAudioBuffer(buffer, endpoint)
    : await transcribeAudioBlob(req.audio, endpoint)
  return { text }
}

/**
 * Synthesize a speech clip through the user's selected engine — the shared
 * engine path of the `synthesizeTextToSpeech` tool (Artifact's `create-speech`
 * to be) and the Home Agent voice reply. Qwen3 honors the full voice request;
 * Kokoro and the external endpoint synthesize with their configured voice.
 *
 * Attended synthesis throws on failure; only an `unattended` request can
 * resolve `null` (prerequisites missing), which the overloads keep honest in
 * the type — attended callers may use the clip without a null check.
 */
export function synthesizeClip(
  req: SynthesizeClipRequest & { unattended: true },
): Promise<SpeechClipResult | null>
export function synthesizeClip(req: SynthesizeClipRequest): Promise<SpeechClipResult>
export async function synthesizeClip(req: SynthesizeClipRequest): Promise<SpeechClipResult | null> {
  const tts = useTextToSpeech()
  const text = req.text

  if (tts.selectedEngine === 'qwen3') {
    const qwen3 = useQwen3TextToSpeech()
    if (req.unattended) {
      // `synthesize` would open the download popup for a missing model, so
      // check first and bail out instead.
      if (!qwen3.isBackendSetUp() || !(await qwen3.isModelInstalled())) return null
    }
    const voice = req.voice
    if (voice?.rememberAsDefault) {
      await qwen3.applyUserVoicePreference({
        speaker: voice.speaker as Qwen3TtsSpeakerId | undefined,
        language: voice.language as Qwen3TtsLanguage | undefined,
        mode: voice.mode,
      })
    }
    // A saved voice always resolves to voice_design; otherwise the given mode.
    const loadMode = voice?.voiceName ? 'voice_design' : voice?.mode
    req.onPhase?.('loading-model')
    if (!(await qwen3.isModelLoaded(loadMode))) {
      await qwen3.ensureModelLoaded(loadMode)
    }
    req.onPhase?.('generating')
    const result = await qwen3.synthesize({
      text,
      language: voice?.language as Qwen3TtsLanguage | undefined,
      speaker: voice?.speaker as Qwen3TtsSpeakerId | undefined,
      instruct: voice?.instruct,
      mode: voice?.mode,
      voiceName: voice?.voiceName,
      seed: voice?.seed,
      designNewVoice: voice?.designNewVoice,
    })
    return {
      audioBase64: result.audioBase64,
      mediaType: result.mediaType || 'audio/wav',
      voice: result.speaker,
      engine: 'qwen3',
      mode: result.mode,
      language: result.language,
    }
  }

  req.onPhase?.('generating')
  return kokoroExternalClip({ text, interactive: !req.unattended, format: req.format })
}

/**
 * The one Kokoro/external wire-up, shared by attended and unattended
 * synthesis and by desktop playback. Attended goes through the TTS store's
 * `synthesizeToWav` (which may prompt the Kokoro model download); unattended
 * starts the OVMS speech server dialog-free and bails out (`null`) when no
 * endpoint can serve.
 */
async function kokoroExternalClip(req: {
  text: string
  interactive: boolean
  format?: 'wav'
}): Promise<SpeechClipResult | null> {
  const tts = useTextToSpeech()

  if (req.interactive) {
    const { audioBase64, voice } = await tts.synthesizeToWav(req.text)
    return {
      audioBase64,
      mediaType: 'audio/wav',
      voice,
      engine: tts.selectedEngine === 'kokoro' ? 'kokoro' : 'external',
    }
  }

  // Kokoro / external endpoint. `available` covers exactly those two.
  if (!tts.available) return null
  // Start the OVMS speech server on demand (no dialog; no-op if already up or
  // the model isn't installed — a configured fallback still serves).
  await tts.ensureSpeechServerRunning()
  const endpoint = await tts.resolveSpeech()
  if (!endpoint) return null
  const { bytes, mediaType } = await synthesizeSpeech(
    req.text,
    endpoint,
    req.format ? { format: req.format } : undefined,
  )
  return {
    audioBase64: bytesToBase64(bytes),
    mediaType: mediaType || 'audio/wav',
    voice: endpoint.voice,
    engine: tts.selectedEngine === 'kokoro' ? 'kokoro' : 'external',
  }
}

/**
 * Persist a speech clip under Documents/AI-Playground/audio and return the
 * path. The IPC is engine-agnostic, so this must not borrow the Qwen3 store's
 * saver — a clip here can come from any engine.
 */
export async function saveSpeechClip(
  audioBase64: string,
  suggestedName: string,
  options?: { overwrite?: boolean },
): Promise<string> {
  const result = await window.electronAPI.saveGeneratedAudio(audioBase64, suggestedName, options)
  if (!result.success) {
    throw new Error(result.error)
  }
  return result.filePath
}

/**
 * Desktop playback state for "Speak replies" and the per-message Speak button.
 * Module refs, not store state: playback is transient, and the engine seam
 * owns it so the drivers (Chat.vue) need no TTS store import.
 */
export const isSpeaking = ref(false)
/** True while `speak()` is spawning the backend or synthesizing before playback. */
export const preparingSpeech = ref(false)
export const speakingMessageId = ref<string | null>(null)
/** Set by the mic flow when a turn originated from speech, consumed by the
 *  speak-replies watcher so only voice-originated turns auto-speak. */
export const pendingVoiceTurn = ref(false)
/** True while the STT store checks a model, downloads it, or starts the server. */
export const preparingStt = computed(() => useSpeechToText().preparingStt)

/** Whether reply playback is usable at all: Kokoro (OVMS) or a configured
 *  external endpoint. Deliberately excludes Qwen3 — its model load is too
 *  slow for auto-speak and its download prompt has nowhere to land mid-reply. */
export function speakRepliesAvailable(): boolean {
  return useTextToSpeech().available
}

/** Stop any in-progress playback and release the object URL. */
export function stopSpeaking(): void {
  speakGeneration++
  preparingSpeech.value = false
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.src = ''
    currentAudio = null
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = null
  }
  isSpeaking.value = false
  speakingMessageId.value = null
}

let currentAudio: HTMLAudioElement | null = null
let currentObjectUrl: string | null = null
let speakGeneration = 0

/**
 * Synthesize `text` and play it back in the desktop app. `messageId` ties the
 * playback to a specific chat message so the UI can show a stop affordance.
 */
export async function speak(req: { text: string; messageId?: string }): Promise<void> {
  const trimmed = markdownToSpeechText(req.text ?? '').trim()
  if (!trimmed) return
  if (preparingSpeech.value) return

  stopSpeaking()
  const gen = speakGeneration
  preparingSpeech.value = true
  speakingMessageId.value = req.messageId ?? null

  try {
    // Reply playback synthesizes through the shared non-Qwen3 path in its
    // unattended shape: it never prompts (a download popup has nowhere to land
    // mid-reply), degrading to a reported unavailability instead.
    const clip = await kokoroExternalClip({ text: trimmed, interactive: false })
    if (gen !== speakGeneration) return
    if (!clip) {
      useErrors().report(
        createAppError({
          category: 'inference',
          code: 'inference/tts-unavailable',
          userMessage: 'Text To Speech is not available (no OVMS server or fallback configured)',
          surface: 'toast',
        }),
      )
      return
    }

    isSpeaking.value = true

    const url = bytesToBlobUrl(base64ToBytes(clip.audioBase64), clip.mediaType)
    currentObjectUrl = url

    const audio = new Audio(url)
    currentAudio = audio
    audio.onended = () => stopSpeaking()
    audio.onerror = () => stopSpeaking()
    await audio.play()
  } catch (error) {
    if (gen !== speakGeneration) return
    useErrors().report(error, {
      category: 'inference',
      code: 'inference/tts-failed',
      userMessage: `Failed to play speech: ${error instanceof Error ? error.message : error}`,
      surface: 'toast',
    })
    stopSpeaking()
  } finally {
    if (gen === speakGeneration) {
      preparingSpeech.value = false
      if (!isSpeaking.value) speakingMessageId.value = null
    }
  }
}
