/**
 * A Session's shared chat transcript: the messages of its display timeline that
 * carry `metadata.chatTurn`. The chat store addresses it under a conversation
 * key of its own, so Home Agent threads keep their keys and their files.
 */

const SESSION_CHAT_PREFIX = 'session:'

export type ChatTranscriptMessage = {
  id: string
  role: string
  parts?: unknown[]
  metadata?: { chatTurn?: boolean; sessionUpdate?: string } & Record<string, unknown>
} & Record<string, unknown>

export function sessionChatKey(sessionId: string): string {
  return `${SESSION_CHAT_PREFIX}${sessionId}`
}

export function sessionIdOfChatKey(conversationKey: string): string | null {
  return conversationKey.startsWith(SESSION_CHAT_PREFIX)
    ? conversationKey.slice(SESSION_CHAT_PREFIX.length) || null
    : null
}

export function asChatTranscriptMessage(value: unknown): ChatTranscriptMessage | null {
  const message = value as ChatTranscriptMessage | null
  return message && typeof message.id === 'string' && message.metadata?.chatTurn === true
    ? message
    : null
}

export function chatTranscriptOf(timeline: readonly unknown[]): ChatTranscriptMessage[] {
  return timeline.flatMap((value) => {
    const message = asChatTranscriptMessage(value)
    return message ? [message] : []
  })
}
