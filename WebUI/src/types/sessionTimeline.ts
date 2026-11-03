import type { MediaItem } from './mediaItem'

/**
 * The display timeline in `session.json`: UI messages in the order they
 * happened. A media turn is a user prompt followed by an assistant message
 * whose `data-media` part is the result card.
 */

export type MediaTurnStatus = 'completed' | 'failed' | 'cancelled'

export type MediaTurnData = {
  runId: string
  mode: 'imageGen' | 'imageEdit' | 'video'
  preset: string
  variant?: string
  status: MediaTurnStatus
  error?: string
  items: MediaItem[]
}

/** A Text-to-Speech or Speech-to-Text turn's result: the audio in `files/` and, for STT, the transcript. */
export type AudioTurnData = {
  kind: 'tts' | 'stt'
  preset: string
  status: MediaTurnStatus
  error?: string
  /** TTS: the synthesized clip; STT: the source audio. */
  audioUrl?: string
  transcript?: string
  /** The speech engine that ran the turn (Qwen TTS, Kokoro, Whisper, …). */
  engine?: string
}

export type TimelinePart =
  | { type: 'text'; text: string }
  | { type: 'data-media'; data: MediaTurnData }
  | { type: 'data-audio'; data: AudioTurnData }

export type TimelineMessage = {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  parts: TimelinePart[]
}
