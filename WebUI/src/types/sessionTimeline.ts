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

export type TimelinePart =
  { type: 'text'; text: string } | { type: 'data-media'; data: MediaTurnData }

export type TimelineMessage = {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  parts: TimelinePart[]
}
