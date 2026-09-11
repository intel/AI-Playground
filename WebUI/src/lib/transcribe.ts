import { convertToWav } from '@/lib/audioUtils'
import type { TranscriptionEndpoint } from '@/assets/js/store/speechToText'

/** Decode a base64 string into a Blob with the given MIME type. */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

/**
 * Transcribe already-WAV (or otherwise server-acceptable) audio bytes against an
 * OpenAI-compatible `/audio/transcriptions` endpoint.
 *
 * The request is built here rather than through the AI SDK's OpenAI
 * transcription model, which asks for `response_format=verbose_json` whenever
 * the model id is `whisper-1` and then validates the reply against OpenAI's
 * exact verbose shape. whisper.cpp's server omits `seek` and
 * `compression_ratio` from its segments, so a perfectly good transcript was
 * rejected as "Invalid JSON response". Plain `json` is the smallest format every
 * server agrees on and carries the only field we use.
 */
export async function transcribeAudioBuffer(
  buffer: ArrayBuffer,
  cfg: TranscriptionEndpoint,
): Promise<string> {
  const form = new FormData()
  form.append('file', new File([buffer], 'audio.wav', { type: 'audio/wav' }))
  form.append('model', cfg.model)
  form.append('response_format', 'json')

  const headers: Record<string, string> = {}
  if (cfg.apiKey) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`
  }

  const url = `${cfg.baseURL.replace(/\/$/, '')}/audio/transcriptions`
  const response = await fetch(url, { method: 'POST', headers, body: form })
  const body = await response.text()

  if (!response.ok) {
    throw new Error(
      `Transcription failed (${response.status}): ${serverMessage(body) || response.statusText}`,
    )
  }

  const payload = parseJsonObject(body)
  if (payload) {
    if (typeof payload.text === 'string') return payload.text.trim()
    throw new Error(`Transcription response carried no text: ${serverMessage(body)}`)
  }

  // A server set to `response_format=text` answers with the bare transcript.
  // Anything else (an HTML error page, say) must not be taken for speech.
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.startsWith('text/plain')) return body.trim()
  throw new Error(`Transcription response was not JSON: ${excerpt(body)}`)
}

/**
 * Convert an arbitrary audio Blob (webm, ogg/opus, mp3, …) to WAV and
 * transcribe it. WAV is accepted by both the OVMS Whisper server and
 * whisper.cpp's OpenAI-compatible endpoint.
 */
export async function transcribeAudioBlob(blob: Blob, cfg: TranscriptionEndpoint): Promise<string> {
  const wavBlob = await convertToWav(blob)
  return transcribeAudioBuffer(await wavBlob.arrayBuffer(), cfg)
}

/** A JSON object body, or `null` for anything else (plain text, HTML, garbage). */
function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The sentence a server put in its error body, whatever shape it chose. */
function serverMessage(body: string): string {
  const payload = parseJsonObject(body) as {
    error?: { message?: string } | string
    message?: string
  } | null
  const error = payload?.error
  const message = typeof error === 'string' ? error : (error?.message ?? payload?.message)
  return message || excerpt(body)
}

function excerpt(body: string): string {
  const text = body.trim().replace(/\s+/g, ' ')
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}
