import type { MediaTurnData, TimelineMessage, TimelinePart } from '@/types/sessionTimeline'

/**
 * What the Session timeline renders, one block per turn. Later turn kinds
 * (chat replies, agent turns, Task Runs) add their own block here.
 */
export type TimelineTurn =
  | { kind: 'media'; id: string; prompt: string; createdAt: number; media: MediaTurnData }
  | { kind: 'message'; id: string; message: TimelineMessage }

function isTimelineMessage(value: unknown): value is TimelineMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<TimelineMessage>
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    Array.isArray(message.parts)
  )
}

function mediaPart(message: TimelineMessage): MediaTurnData | null {
  const part = message.parts.find(
    (candidate): candidate is Extract<TimelinePart, { type: 'data-media' }> =>
      candidate.type === 'data-media',
  )
  return part?.data ?? null
}

function promptOf(message: TimelineMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

/** Pairs each prompt with the result card that answered it; anything else stays a plain message. */
export function timelineTurns(timeline: readonly unknown[]): TimelineTurn[] {
  const messages = timeline.filter(isTimelineMessage)
  const turns: TimelineTurn[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const next = messages[i + 1]
    const media = next?.role === 'assistant' ? mediaPart(next) : null
    if (message.role === 'user' && next && media) {
      turns.push({
        kind: 'media',
        id: next.id,
        prompt: promptOf(message),
        createdAt: message.createdAt,
        media,
      })
      i++
      continue
    }
    turns.push({ kind: 'message', id: message.id, message })
  }
  return turns
}
