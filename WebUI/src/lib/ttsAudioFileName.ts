import {
  HOME_AGENT_CONVERSATION_TITLE,
  type ConversationThreadMeta,
} from '@/assets/js/store/conversations'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'

function slugifySegment(value: string, maxLen: number): string {
  const slug = value
    .trim()
    .replace(/[^\w\s\-]+/g, '')
    .replace(/[\s\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, maxLen)
  return slug || 'untitled'
}

/** Local timestamp for filenames: `20260701_143052123`. */
export function formatTtsAudioTimestamp(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`
  )
}

export function conversationLabelForTtsFile(args: {
  conversationKey: string
  messages: AipgUiMessage[] | undefined
  threadMeta: ConversationThreadMeta | undefined
}): string {
  const { conversationKey, messages, threadMeta } = args
  const titled = messages?.[0]?.metadata?.conversationTitle
  if (typeof titled === 'string' && titled.trim()) {
    return titled.trim()
  }
  if (threadMeta?.kind === 'homeAgent') {
    return HOME_AGENT_CONVERSATION_TITLE
  }
  const firstText = messages?.[0]?.parts?.find((p) => p.type === 'text')
  if (firstText && firstText.type === 'text' && firstText.text?.trim()) {
    return firstText.text.trim().slice(0, 50)
  }
  return `chat_${conversationKey.slice(-8)}`
}

/**
 * Build a unique WAV filename: conversation slug + short key + timestamp + optional user slug.
 */
export function buildTtsAudioFileName(args: {
  conversationKey: string
  conversationLabel: string
  userSlug?: string
  now?: Date
}): string {
  const now = args.now ?? new Date()
  const convPart = slugifySegment(args.conversationLabel, 36)
  const keyPart = slugifySegment(args.conversationKey.slice(-10), 12)
  const timePart = formatTtsAudioTimestamp(now)
  const userPart = args.userSlug?.trim()
    ? slugifySegment(args.userSlug.replace(/\.wav$/i, ''), 24)
    : ''
  const stem = [convPart, keyPart, timePart, userPart].filter(Boolean).join('_')
  return `${stem}.wav`
}
