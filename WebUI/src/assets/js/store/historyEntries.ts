import type { UIMessage } from 'ai'
import type { ThreadKind } from './conversations'
import type { GenerationSettings, MediaItem } from './imageGenerationPresets'
import { sessionListedUnderPreset } from './agentModeSessions'
import type { HeldAnswerView } from './channels/answerRouter'
import { extractToolMedia, type ToolMediaItem } from '@/assets/js/tools/toolMedia'
import type { PauseReason } from '@/types/kernelEvents'

// One history model for every reopenable unit of work. The window filters; the
// runtimes behind a row stay specialized (LLM chat, direct TTS, direct STT,
// Pi + workspace, ComfyUI canvas), which is what `kind` and the preset select.
//
// Pure on purpose: no store imports, so the projector can be replaced (Phase 2
// collapses the three persisted maps into one) without touching this file, and
// so the filter/search rules are unit-testable.

export type EntryBase = {
  id: string
  title: string
  presetName?: string
  mode: ModeType
  createdAt: number
  updatedAt: number
}

/** Assistant, Text to Speech, Speech to Text, Home Agent — anything with a transcript. */
export type ConversationEntry = EntryBase & {
  kind: 'conversation'
  threadKind: ThreadKind
  variant?: string | null
  ragDocHashes?: string[]
  messages: UIMessage[]
}

/** What an Agent Session's turn is doing, or how it went while nobody was looking. */
export type AgentSessionStatus =
  'running' | 'queued' | 'paused' | 'downloading' | 'unseen' | 'unseenFailed'

/** Agent, Game Agent, Quick Coder: a transcript plus a workspace folder. */
export type AgentEntry = EntryBase & {
  kind: 'agent'
  workspaceDir: string
  capabilities?: string[]
  messages: UIMessage[]
  status?: AgentSessionStatus
  /** 1-based Turn Queue place, only while `queued` and known. */
  queuePosition?: number
  /** What the user is asked, only while `paused` and known. */
  pauseReason?: PauseReason
  /** The Model Download it waits on, only while `downloading`. */
  download?: SessionDownload
  taskId?: string
  /** A channel's Answer waiting for this session's turn to end. */
  heldAnswer?: HeldAnswerView
}

/** Overall percent of the Model Download a session waits on, or that it is still queued. */
export type SessionDownload = { percent: number; queued: boolean }

/**
 * One canvas output. `origin` is what keeps a tool's image from being listed
 * twice: it already rides the transcript card of the turn that asked for it.
 */
export type MediaEntry = EntryBase & {
  kind: 'media'
  origin: 'canvas' | 'tool'
  media: MediaItem
}

/** A row of the retired history list over the old records; Sessions replaced it in the panel. */
export type RecordRow = ConversationEntry | AgentEntry | MediaEntry

export type HistoryFilter = 'current' | 'all'

export type FilterContext = {
  filter: HistoryFilter
  currentMode: ModeType
  /** Agent preset the Agent list belongs to; Game Agent and Quick Coder share one. */
  agentPresetName?: string
  /**
   * Which transcripts the current-mode list is about. Home Agent behaves like a
   * mode of its own: while the app is on a remote thread, local chats are as
   * out of scope as an image would be.
   */
  threadScope?: ThreadKind
  /** Thread the app is sitting on, so its unsent draft can still be shown. */
  activeConversationId?: string | null
}

const WORKFLOW_MODES: readonly string[] = ['imageGen', 'imageEdit', 'video']

/**
 * A turn in flight outranks an unseen result: the dot is about the last turn, and
 * a new one has already started. Waiting on a Model Download is not a pause:
 * nobody is being asked anything (docs/adr/0005).
 */
export function agentSessionStatus(input: {
  turn?: {
    state: 'queued' | 'running' | 'paused'
    queuePosition?: number | null
    pauseReason?: PauseReason
  }
  unseen?: 'done' | 'failed'
  download?: SessionDownload | null
}): {
  status?: AgentSessionStatus
  queuePosition?: number
  pauseReason?: PauseReason
  download?: SessionDownload
} {
  const { turn, unseen, download } = input
  if (turn && download && turn.state !== 'paused') return { status: 'downloading', download }
  if (turn?.state === 'queued') {
    return turn.queuePosition
      ? { status: 'queued', queuePosition: turn.queuePosition }
      : { status: 'queued' }
  }
  if (turn?.state === 'paused' && turn.pauseReason) {
    return { status: 'paused', pauseReason: turn.pauseReason }
  }
  if (turn) return { status: turn.state }
  if (unseen === 'failed') return { status: 'unseenFailed' }
  if (unseen === 'done') return { status: 'unseen' }
  return {}
}

const PAUSE_KIND_KEYS: Record<PauseReason['kind'], string> = {
  download: 'HISTORY_PAUSE_DOWNLOAD',
  'vram-warning': 'HISTORY_PAUSE_VRAM_WARNING',
  confirmation: 'HISTORY_PAUSE_CONFIRMATION',
  question: 'HISTORY_PAUSE_QUESTION',
}

/** "Needs you: model download · Qwen3.8-27B", plus the kind alone for the row's marker. */
export function pausedStatusLabel(
  reason: PauseReason | undefined,
  labels: Record<string, string>,
): { label: string; short?: string } {
  const kind = reason ? labels[PAUSE_KIND_KEYS[reason.kind]] : undefined
  if (!reason || !kind) return { label: labels.HISTORY_STATUS_PAUSED }
  const label = labels.HISTORY_STATUS_PAUSED_FOR.replace('{reason}', kind)
  return { label: reason.summary ? `${label} · ${reason.summary}` : label, short: kind }
}

const ORDINAL_KEYS: Partial<Record<Intl.LDMLPluralRule, string>> = {
  one: 'HISTORY_QUEUE_ORDINAL_ONE',
  two: 'HISTORY_QUEUE_ORDINAL_TWO',
  few: 'HISTORY_QUEUE_ORDINAL_FEW',
}

/** "2nd" in English; each locale's ordinal pattern comes from its own strings. */
export function queueOrdinal(
  position: number,
  locale: string,
  labels: Record<string, string>,
): string {
  let category: Intl.LDMLPluralRule = 'other'
  try {
    category = new Intl.PluralRules(locale, { type: 'ordinal' }).select(position)
  } catch {
    // An unknown locale tag falls back to the generic pattern.
  }
  const pattern =
    labels[ORDINAL_KEYS[category] ?? 'HISTORY_QUEUE_ORDINAL_OTHER'] ??
    labels.HISTORY_QUEUE_ORDINAL_OTHER ??
    '{n}'
  return pattern.replace('{n}', String(position))
}

export function isWorkflowMode(mode: ModeType): mode is WorkflowModeType {
  return WORKFLOW_MODES.includes(mode)
}

/**
 * The mode a transcript is listed under. Never `agent`: an agent run is its own
 * kind, so a chat preset marked `agentPreset` cannot own a conversation row.
 */
export function conversationMode(presetMode: ModeType | null | undefined): ModeType {
  return presetMode === 'audio' ? 'audio' : 'chat'
}

type TitledMessage = UIMessage & { metadata?: { conversationTitle?: string; timestamp?: number } }

function messageText(message: UIMessage | undefined): string {
  return (
    message?.parts
      ?.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
      .trim() ?? ''
  )
}

function messageTime(message: UIMessage | undefined): number | undefined {
  return (message as TitledMessage | undefined)?.metadata?.timestamp
}

export function conversationTitle(messages: UIMessage[]): string {
  if (messages.length === 0) return 'New Conversation'
  const named = (messages[0] as TitledMessage).metadata?.conversationTitle
  if (named) return named
  const text = messageText(messages[0])
  return text ? text.slice(0, 50) : 'New Conversation'
}

/**
 * A conversation key is the `Date.now()` it was minted at, which is the only
 * creation time stored. Message metadata carries the rest.
 */
export function conversationTimes(
  key: string,
  messages: UIMessage[],
): { createdAt: number; updatedAt: number } {
  const fromKey = Number(key)
  const createdAt =
    Number.isFinite(fromKey) && fromKey > 0 ? fromKey : (messageTime(messages[0]) ?? 0)
  const last = messageTime(messages[messages.length - 1]) ?? createdAt
  return { createdAt, updatedAt: Math.max(createdAt, last) }
}

export function mediaUrl(item: MediaItem): string {
  if (item.type === 'video') return item.videoUrl
  if (item.type === 'model3d') return item.model3dUrl
  return item.imageUrl
}

/** Items persisted by older versions can carry no `settings` at all. */
export function mediaSettings(item: MediaItem): GenerationSettings {
  return item.settings ?? {}
}

export function mediaTitle(item: MediaItem): string {
  const settings = mediaSettings(item)
  const prompt = settings.prompt?.trim()
  if (prompt) return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt
  return settings.preset?.trim() || 'Untitled'
}

/** A run in flight has no timestamp yet, and belongs at the top of the list. */
export function mediaTimes(item: MediaItem, now: number): { createdAt: number; updatedAt: number } {
  const createdAt = item.createdAt ?? now
  return { createdAt, updatedAt: createdAt }
}

export function toolMedia(messages: UIMessage[]): ToolMediaItem[] {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) =>
      extractToolMedia(part as { type: string; state?: string; output?: unknown }),
    ),
  )
}

/** Every media URL a transcript already shows, i.e. what a canvas row must not repeat. */
export function collectToolMediaUrls(transcripts: UIMessage[][]): Set<string> {
  const urls = new Set<string>()
  for (const messages of transcripts) {
    for (const item of toolMedia(messages)) urls.add(item.url)
  }
  return urls
}

/**
 * A thread nothing was ever sent to. Hydration always keeps one, so it is
 * chrome for "what the next send goes into", not a record of past work.
 */
export function isEmptyDraft(entry: RecordRow): boolean {
  return entry.kind === 'conversation' && entry.messages.length === 0
}

export function matchesFilter(entry: RecordRow, context: FilterContext): boolean {
  // A tool's output is already on the card of the turn that produced it.
  if (entry.kind === 'media' && entry.origin === 'tool') return false
  if (isEmptyDraft(entry) && entry.id !== context.activeConversationId) return false
  if (context.filter === 'all') return true
  switch (entry.kind) {
    case 'conversation':
      return (
        entry.mode === context.currentMode && entry.threadKind === (context.threadScope ?? 'main')
      )
    case 'agent':
      return (
        context.currentMode === 'agent' &&
        sessionListedUnderPreset(entry.presetName, context.agentPresetName ?? '')
      )
    case 'media':
      return entry.mode === context.currentMode
  }
}

/** One of the Task's Task Sessions, whatever state its run ended in. */
export function matchesTask(entry: RecordRow, taskId: string): boolean {
  return entry.kind === 'agent' && entry.taskId === taskId
}

/**
 * Whether the row's runtime is the one on screen. Each kind remembers its own
 * selection, so under All a selected image, transcript and agent session would
 * otherwise all be marked active while only one of them is showing.
 */
export function entryRuntimeShown(entry: RecordRow, currentMode: ModeType): boolean {
  switch (entry.kind) {
    // Chat and Audio render the same transcript view.
    case 'conversation':
      return currentMode === 'chat' || currentMode === 'audio'
    case 'agent':
      return currentMode === 'agent'
    case 'media':
      return currentMode === entry.mode
  }
}

/** Title, preset, prompt, and the first thing the user said. */
export function entryHaystack(entry: RecordRow): string {
  const parts = [entry.title, entry.presetName ?? '']
  if (entry.kind === 'media') {
    const settings = mediaSettings(entry.media)
    parts.push(settings.prompt ?? '', settings.variant ?? '')
  } else {
    parts.push(messageText(entry.messages.find((message) => message.role === 'user')))
    if (entry.kind === 'agent') parts.push(entry.workspaceDir)
  }
  return parts.join(' ').toLowerCase()
}

export function searchEntries(entries: RecordRow[], query: string): RecordRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter((entry) => entryHaystack(entry).includes(needle))
}

export function sortEntries(entries: RecordRow[]): RecordRow[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

export function dayLabel(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp)
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const minutes = Math.round((now - timestamp) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}
