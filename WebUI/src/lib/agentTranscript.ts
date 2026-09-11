// Reading Agent Mode's transcript: what a UI message part *is*, and how a run of
// thinking-and-tool-calling parts collapses into one line.
//
// A single request can produce dozens of reasoning blocks and tool calls, which
// pushes the actual answer (and any generated media) off screen. So a settled
// run of those parts is folded into `Reasoned for 12.3 seconds, used 4 tools`,
// expandable on demand. Anything that carries a result the user came for — the
// answer text, generated media, a screenshot, a compaction notice — is never
// folded, and neither is work still in flight: watching the agent work is the
// point while it happens.
//
// Pi's dynamic tools are not in the app's tool union, so parts are inspected
// structurally instead of being cast to a typed part.

import { reasoningElapsedMsFromParts } from './reasoningTimings'

type PartShape = {
  type?: unknown
  state?: unknown
  toolName?: unknown
  output?: unknown
  toolCallId?: unknown
  input?: unknown
}

function shapeOf(part: unknown): PartShape {
  return typeof part === 'object' && part !== null ? (part as PartShape) : {}
}

/** Tool name of a tool part, in either encoding (`tool-bash` / `dynamic-tool`). */
export function toolPartNameOf(part: unknown): string | undefined {
  const { type, toolName } = shapeOf(part)
  if (type === 'dynamic-tool') return typeof toolName === 'string' ? toolName : undefined
  if (typeof type === 'string' && type.startsWith('tool-')) return type.slice('tool-'.length)
  return undefined
}

export function isReasoningPart(part: unknown): boolean {
  return shapeOf(part).type === 'reasoning'
}

/** Pi's context compaction, which the translator reports as a synthetic call. */
export type CompactionOutput = {
  trigger: 'manual' | 'threshold' | 'overflow'
  summary: string
  tokensBefore?: number
  tokensAfter?: number
}

export function compactionOutputOf(part: unknown): CompactionOutput | null {
  const { type, toolName, output } = shapeOf(part)
  if (type !== 'dynamic-tool' || toolName !== 'compaction') return null
  return output && typeof output === 'object' ? (output as CompactionOutput) : null
}

/** The bridged media tools, whose results render as images/video/3D models. */
const MEDIA_BRIDGE_TOOL_NAMES = new Set(['media', 'generateImage', 'editImage'])

export function mediaToolNameOf(part: unknown): string | undefined {
  const name = toolPartNameOf(part)
  return name && MEDIA_BRIDGE_TOOL_NAMES.has(name) ? name : undefined
}

export type TranscriptSegment =
  | { kind: 'part'; key: string; part: unknown }
  | { kind: 'chain'; key: string; parts: unknown[]; summary: string }

export type GroupOptions = {
  /** Keeps segment keys of one message apart from another's. */
  messageId: string
  /**
   * Whether the agent is producing this message right now. The turn in flight is
   * shown in full — watching the agent work is the point while it works — and
   * folds once it is over, whatever state its parts ended in (so a turn
   * abandoned mid-thought does not stay unfolded forever).
   */
  live: boolean
  /** Parts eligible for folding, minus the ones the caller renders richly. */
  foldable: (part: unknown) => boolean
}

/** Folding a lone part gains nothing: its card *is* one line already. */
const MIN_CHAIN_LENGTH = 2

/**
 * Split a message's parts into what to render: single parts as they are, and
 * runs of foldable parts as one collapsed summary.
 */
export function groupTranscriptParts(
  parts: readonly unknown[],
  options: GroupOptions,
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  let chain: { parts: unknown[]; startIndex: number } | undefined

  const flush = () => {
    if (!chain) return
    const key = `${options.messageId}:chain:${chain.startIndex}`
    if (chain.parts.length >= MIN_CHAIN_LENGTH) {
      segments.push({ kind: 'chain', key, parts: chain.parts, summary: summarize(chain.parts) })
    } else {
      for (const [offset, part] of chain.parts.entries()) {
        segments.push({
          kind: 'part',
          key: `${options.messageId}:${chain.startIndex + offset}`,
          part,
        })
      }
    }
    chain = undefined
  }

  parts.forEach((part, index) => {
    if (options.live || !options.foldable(part)) {
      flush()
      segments.push({ kind: 'part', key: `${options.messageId}:${index}`, part })
      return
    }
    chain ??= { parts: [], startIndex: index }
    chain.parts.push(part)
  })
  flush()
  return segments
}

function summarize(parts: readonly unknown[]): string {
  const reasoningMs = reasoningElapsedMsFromParts(parts)
  const tools = parts.filter((part) => toolPartNameOf(part) !== undefined)
  const failed = tools.filter((part) => shapeOf(part).state === 'output-error').length
  const clauses: string[] = []
  if (reasoningMs > 0) clauses.push(`Reasoned for ${formatDuration(reasoningMs)}`)
  if (tools.length > 0) {
    const noun = tools.length === 1 ? 'tool' : 'tools'
    clauses.push(`${clauses.length > 0 ? 'used' : 'Used'} ${tools.length} ${noun}`)
  }
  // A transcript from before durations were recorded still gets a count.
  if (clauses.length === 0) clauses.push(`${parts.length} reasoning steps`)
  const summary = clauses.join(', ')
  return failed > 0 ? `${summary} (${failed} failed)` : summary
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} seconds`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

function truncate(value: unknown, max = 48): string {
  if (typeof value !== 'string') return ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function objectInputOf(part: unknown): Record<string, unknown> | undefined {
  const input = shapeOf(part).input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** One-line label for a tool that is currently running. */
export function toolActionLabel(name: string, input?: Record<string, unknown>): string {
  const filePath = truncate(input?.file_path)
  switch (name) {
    case 'read':
      return `Reading ${filePath}…`
    case 'edit':
      return `Editing ${filePath}…`
    case 'write':
      return `Writing ${filePath}…`
    case 'ls':
      return 'Listing files…'
    case 'bash':
      return `Running: ${truncate(input?.command)}`
    case 'navigate_page':
      return input?.url ? `Opening ${truncate(input.url)}…` : 'Navigating…'
    case 'list_console_messages':
      return 'Reading browser console…'
    case 'list_pages':
      return 'Listing browser pages…'
    case 'take_screenshot':
      return 'Taking screenshot…'
    case 'take_snapshot':
      return 'Snapshotting page…'
    case 'evaluate_script':
      return 'Running script in page…'
    case 'generateImage':
      return 'Generating image…'
    case 'editImage':
      return 'Editing image…'
    case 'media':
      return 'Creating media…'
    default:
      return `Running ${name}…`
  }
}

/**
 * What the Agent Mode status line should say for this message's parts.
 * A finished tool means the model is deciding its next step.
 */
export function busyLabelOf(
  parts: readonly unknown[],
  mediaStepLabel?: (toolCallId: string) => string | undefined,
): string {
  const lastPart = parts.at(-1)
  if (!lastPart) return 'Agent is working…'
  const shape = shapeOf(lastPart)
  if (isReasoningPart(lastPart) && shape.state !== 'done') return 'Thinking…'
  if (shape.type === 'text' && shape.state === 'streaming') return 'Writing response…'
  const toolName = toolPartNameOf(lastPart)
  if (!toolName) return 'Agent is working…'
  if (shape.state === 'input-streaming' || shape.state === 'input-available') {
    const toolCallId = typeof shape.toolCallId === 'string' ? shape.toolCallId : undefined
    if (toolCallId && mediaStepLabel) {
      const media = mediaStepLabel(toolCallId)
      if (media) return media
    }
    return toolActionLabel(toolName, objectInputOf(lastPart))
  }
  return 'Thinking…'
}
