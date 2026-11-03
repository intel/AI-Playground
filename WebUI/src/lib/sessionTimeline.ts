import type { UIMessage } from 'ai'
import type {
  AgentTurnTag,
  AudioTurnData,
  MediaTurnData,
  TaskRunTag,
  TimelineMessage,
  TimelinePart,
} from '@/types/sessionTimeline'
import { asChatTranscriptMessage } from '@/lib/sessionChat'

/** What the Session timeline renders, one block per turn; a Task Run is an agent block. */
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
      taskRun?: TaskRunTag
      /** Set on the last block of a Harness Session that is open or running. */
      live?: LiveAgentTurn
    }
  | { kind: 'chat'; id: string; messages: UIMessage[] }

function isMessageShaped(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const message = value as { id?: unknown; role?: unknown; parts?: unknown }
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    Array.isArray(message.parts)
  )
}

function isTimelineMessage(value: unknown): value is TimelineMessage {
  return isMessageShaped(value)
}

/** Agent and chat turns are stored as the UI messages their engines produced. */
function isUIMessage(value: unknown): value is UIMessage {
  return isMessageShaped(value)
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

/** A Harness Session's live transcript, streamed into the timeline. */
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

function withLiveChatTurn(
  timeline: readonly unknown[],
  live: readonly { id: string }[],
): unknown[] {
  if (live.length === 0) return [...timeline]
  const tagged = new Map(
    live.map((message) => {
      const metadata = (message as { metadata?: object }).metadata
      return [message.id, { ...message, metadata: { ...metadata, chatTurn: true } }]
    }),
  )
  const merged = timeline.map((value) => {
    const saved = asChatTranscriptMessage(value)
    const copy = saved ? tagged.get(saved.id) : undefined
    if (!saved || !copy) return value
    tagged.delete(saved.id)
    return { ...copy, metadata: { ...saved.metadata, ...copy.metadata } }
  })
  return [...merged, ...tagged.values()]
}

/** Everything of the open Session still in flight, whichever preset or mode started it. */
export type LiveTurns<M extends { runId: string }, A> = {
  /** The Session's chat transcript as the chat store holds it, streaming turn included. */
  chat?: readonly { id: string }[]
  /** Each Harness Session of the Session that is open or running a turn (Task Runs too). */
  agents?: readonly LiveAgentTurn[]
  media?: M | null
  audio?: A | null
}

export type SessionTimelineItem<M = unknown, A = unknown> =
  | TimelineTurn
  | { kind: 'pending-media'; id: string; pending: M }
  | { kind: 'pending-audio'; id: string; pending: A }

/**
 * The one main-area timeline of a Session: its saved turns with every live turn laid
 * over them — a live copy replaces its saved message in place, what is not saved yet
 * follows at the end — so what is on screen never depends on the active mode.
 */
export function sessionTimelineItems<M extends { runId: string }, A>(
  timeline: readonly unknown[],
  live: LiveTurns<M, A>,
): SessionTimelineItem<M, A>[] {
  let merged = withLiveChatTurn(timeline, live.chat ?? [])
  for (const agent of live.agents ?? []) {
    merged = withLiveAgentTurn(merged, agent.tag, agent.messages)
  }
  const turns = timelineTurns(merged)
  for (const agent of live.agents ?? []) {
    const block = turns.findLast(
      (turn) => turn.kind === 'agent' && turn.harnessSessionId === agent.tag.harnessSessionId,
    )
    if (block?.kind === 'agent') block.live = agent
  }
  const items: SessionTimelineItem<M, A>[] = [...turns]
  const media = live.media
  if (media && !turns.some((turn) => turn.kind === 'media' && turn.media.runId === media.runId)) {
    items.push({ kind: 'pending-media', id: media.runId, pending: media })
  }
  if (live.audio) items.push({ kind: 'pending-audio', id: 'pending-audio', pending: live.audio })
  return items
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
    if (tag && isUIMessage(message)) {
      const last = turns.at(-1)
      if (last?.kind === 'agent' && last.harnessSessionId === tag.harnessSessionId) {
        last.messages.push(message)
      } else {
        turns.push({
          kind: 'agent',
          id: message.id,
          presetName: tag.presetName,
          harnessSessionId: tag.harnessSessionId,
          messages: [message],
          ...(tag.taskRun ? { taskRun: tag.taskRun } : {}),
        })
      }
      continue
    }
    if (asChatTranscriptMessage(message) && isUIMessage(message)) {
      const last = turns.at(-1)
      if (last?.kind === 'chat') last.messages.push(message)
      else turns.push({ kind: 'chat', id: message.id, messages: [message] })
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
