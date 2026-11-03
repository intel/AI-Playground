import type { UIMessage } from 'ai'
import type {
  AgentTurnTag,
  AudioTurnData,
  MediaTurnData,
  TimelineMessage,
  TimelinePart,
} from '@/types/sessionTimeline'
import { asChatTranscriptMessage } from '@/lib/sessionChat'

/**
 * What the Session timeline renders, one block per turn. Later turn kinds
 * (chat replies, agent turns, Task Runs) add their own block here.
 */
export type TimelineTurn =
  | { kind: 'media'; id: string; prompt: string; createdAt: number; media: MediaTurnData }
  | { kind: 'audio'; id: string; prompt: string; createdAt: number; audio: AudioTurnData }
  | { kind: 'message'; id: string; message: TimelineMessage }
  | {
      kind: 'agent'
      id: string
      presetName: string
      harnessSessionId: string
      messages: UIMessage[]
    }
  | { kind: 'chat'; id: string; messages: UIMessage[] }

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

function audioPart(message: TimelineMessage): AudioTurnData | null {
  const part = message.parts.find(
    (candidate): candidate is Extract<TimelinePart, { type: 'data-audio' }> =>
      candidate.type === 'data-audio',
  )
  return part?.data ?? null
}

function promptOf(message: TimelineMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

function agentTagOf(value: unknown): AgentTurnTag | null {
  const tag = (value as { metadata?: { agentTurn?: AgentTurnTag } } | null)?.metadata?.agentTurn
  return tag && typeof tag.harnessSessionId === 'string' ? tag : null
}

/** The live turn of the open Harness Session, streamed into the timeline (Agent mode). */
export type LiveAgentTurn = {
  tag: AgentTurnTag
  messages: readonly { id: string }[]
  live: boolean
  queuedMessageId?: string
  notRunMessageId?: string
  canResend?: boolean
}

/**
 * Lays the open Harness Session's live transcript over the saved timeline: a message
 * the Session already holds shows its streaming copy in place, the rest of the
 * running turn follows at the end.
 */
export function withLiveAgentTurn(
  timeline: readonly unknown[],
  tag: AgentTurnTag,
  live: readonly { id: string }[],
): unknown[] {
  if (live.length === 0) return [...timeline]
  const tagged = new Map(
    live.map((message) => {
      const metadata = (message as { metadata?: object }).metadata
      return [message.id, { ...message, metadata: { ...metadata, agentTurn: tag } }]
    }),
  )
  const merged = timeline.map((message) => {
    const id = (message as { id?: unknown } | null)?.id
    const copy = typeof id === 'string' ? tagged.get(id) : undefined
    if (!copy) return message
    tagged.delete(id as string)
    return copy
  })
  return [...merged, ...tagged.values()]
}

/**
 * Pairs each prompt with the result card that answered it, and keeps a run of
 * one Harness Session's messages together as one agent block; anything else
 * stays a plain message.
 */
export function timelineTurns(timeline: readonly unknown[]): TimelineTurn[] {
  const messages = timeline.filter(isTimelineMessage)
  const turns: TimelineTurn[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const tag = agentTagOf(message)
    if (tag) {
      const last = turns.at(-1)
      if (last?.kind === 'agent' && last.harnessSessionId === tag.harnessSessionId) {
        last.messages.push(message as unknown as UIMessage)
      } else {
        turns.push({
          kind: 'agent',
          id: message.id,
          presetName: tag.presetName,
          harnessSessionId: tag.harnessSessionId,
          messages: [message as unknown as UIMessage],
        })
      }
      continue
    }
    if (asChatTranscriptMessage(message)) {
      const last = turns.at(-1)
      if (last?.kind === 'chat') last.messages.push(message as unknown as UIMessage)
      else turns.push({ kind: 'chat', id: message.id, messages: [message as unknown as UIMessage] })
      continue
    }
    const next = messages[i + 1]
    const answer = message.role === 'user' && next?.role === 'assistant' ? next : null
    const media = answer ? mediaPart(answer) : null
    const audio = answer && !media ? audioPart(answer) : null
    if (answer && audio) {
      turns.push({
        kind: 'audio',
        id: answer.id,
        prompt: promptOf(message),
        createdAt: message.createdAt,
        audio,
      })
      i++
      continue
    }
    if (next && media) {
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
