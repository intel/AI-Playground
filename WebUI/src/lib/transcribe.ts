import { createOpenAI } from '@ai-sdk/openai'
import { experimental_transcribe as transcribe } from 'ai'
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
 * Transcribe already-WAV (or otherwise server-acceptable) audio bytes against
 * an OpenAI-compatible transcription endpoint using the AI SDK.
 */
export async function transcribeAudioBuffer(
  buffer: ArrayBuffer,
  cfg: TranscriptionEndpoint,
): Promise<string> {
  const provider = createOpenAI({ name: 'model', baseURL: cfg.baseURL, apiKey: cfg.apiKey })
  const transcriptionModel = provider.transcriptionModel?.(cfg.model)
  if (!transcriptionModel) {
    throw new Error('Transcription model not initialized')
  }
  const result = await transcribe({ model: transcriptionModel, audio: buffer })
  return result.text
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
