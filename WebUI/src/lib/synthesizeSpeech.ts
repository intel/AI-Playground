import type { SpeechEndpoint } from '@/assets/js/store/textToSpeech'

export type SpeechFormat = 'wav' | 'mp3' | 'opus'

/**
 * Synthesize speech from text against an OpenAI-compatible `/audio/speech`
 * endpoint. The request is routed through the Electron main process so it is
 * not subject to the renderer's CORS policy — many OpenAI-compatible servers
 * (including local TTS fallbacks) do not answer the CORS preflight that an
 * `application/json` POST triggers, which would block a direct renderer fetch.
 * A direct `fetch` is kept as a fallback for non-Electron contexts (e.g. tests).
 */
export async function synthesizeSpeech(
  text: string,
  cfg: SpeechEndpoint,
  opts?: { format?: SpeechFormat },
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const format = opts?.format ?? 'wav'

  const electronAPI = (globalThis as { electronAPI?: Window['electronAPI'] }).electronAPI
  if (electronAPI?.synthesizeSpeech) {
    const attempt = (f: SpeechFormat) =>
      electronAPI.synthesizeSpeech({
        baseURL: cfg.baseURL,
        model: cfg.model,
        input: text,
        voice: cfg.voice || undefined,
        apiKey: cfg.apiKey || undefined,
        format: f,
      })
    let result = await attempt(format)
    // Not every OpenAI-compatible server supports opus/mp3 — fall back to wav,
    // which is universally supported, so a voice reply still goes out.
    if (!result.success && format !== 'wav') {
      result = await attempt('wav')
    }
    if (!result.success) {
      throw new Error(result.error)
    }
    return { bytes: base64ToBytes(result.dataBase64), mediaType: result.mediaType }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    input: text,
    response_format: format,
  }
  if (cfg.voice) {
    body.voice = cfg.voice
  }

  const url = `${cfg.baseURL.replace(/\/$/, '')}/audio/speech`
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Speech synthesis failed (${response.status}): ${detail}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const mediaType =
    response.headers.get('content-type')?.split(';')[0]?.trim() || mediaTypeForFormat(format)
  return { bytes: new Uint8Array(arrayBuffer), mediaType }
}

/** Decode a base64 string into raw bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function mediaTypeForFormat(format: SpeechFormat): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg'
    case 'opus':
      return 'audio/ogg'
    case 'wav':
    default:
      return 'audio/wav'
  }
}

/** Wrap raw audio bytes in an object-URL Blob for `HTMLAudioElement` playback. */
export function bytesToBlobUrl(bytes: Uint8Array, mediaType: string): string {
  // Copy into a fresh Uint8Array<ArrayBuffer> so the BlobPart type is satisfied:
  // a bare Uint8Array is generic over ArrayBufferLike (which includes
  // SharedArrayBuffer) and is not assignable to BlobPart under newer TS lib defs.
  const blob = new Blob([new Uint8Array(bytes)], { type: mediaType })
  return URL.createObjectURL(blob)
}

/** Base64-encode raw audio bytes (for sending over channels). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}
