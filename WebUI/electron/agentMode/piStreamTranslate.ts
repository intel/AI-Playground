import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

// ── Pi event stream → AI SDK UI message chunks ───────────────────────────────
//
// Agent Mode's renderer consumes a standard AI SDK UI message stream (an
// @ai-sdk/vue `Chat` fed by a custom IPC transport), so the only translation
// this integration needs is Pi's `AgentSessionEvent` → `UIMessageChunk`. This
// module is that translation and nothing else: no Electron, no Pi session, no
// IPC — a chunk sink goes in, `handle(event)` gets called per Pi event.
//
// Pi models an assistant message as indexed content blocks and emits
// `*_start` / `*_delta` / `*_end` per block, which lines up with the UI
// protocol's `text-*` / `reasoning-*` parts once the block index is turned into
// a part id that is unique per turn (Pi restarts content indices every
// message, the UI protocol wants ids unique for the whole stream).

/** Minimal structural view of the Pi assistant-message events we translate. */
type AssistantMessageEvent = {
  type: string
  contentIndex?: number
  delta?: string
  content?: string
  /** Message so far; the block at `contentIndex` names the streaming tool call. */
  partial?: { content?: unknown[] }
  toolCall?: { id?: string; name?: string }
}

export type UsageTotals = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Provider cost in USD for the whole session; 0 for local models. */
  costUsd?: number
}

export type ContextUsageSnapshot = {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

/** Usage of the most recent model call — the figure Chat mode also reports. */
export type StepUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

/**
 * Everything the translator needs at turn end but cannot read off the event
 * stream: Pi reports usage and context occupancy through session getters, not
 * events.
 */
export type TurnSummary = {
  /** Cumulative totals for the whole session (a cost figure, not occupancy). */
  usage?: UsageTotals
  contextUsage?: ContextUsageSnapshot
  lastStep?: StepUsage
}

/** A chunk of the AI SDK UI message stream. Shape-checked by the renderer. */
export type StreamChunk = Record<string, unknown>

export type StreamTranslatorOptions = {
  emit: (chunk: StreamChunk) => void
  /** Called with each tool progress update instead of the chunk stream. */
  onToolProgress?: (update: { toolCallId: string; toolName: string; text: string }) => void
  /** Clock for reasoning durations; injectable so tests can pin them. */
  now?: () => number
}

export type StreamTranslator = {
  handle: (event: AgentSessionEvent) => void
  /**
   * Revise the in-flight message's usage/context metadata. Pi only reports
   * these through session getters, so the manager samples them during the turn
   * and the gauge in the UI follows along instead of jumping at turn end.
   */
  update: (summary: TurnSummary) => void
  /**
   * Emit host-side text as its own assistant text part. Used for output that
   * does not come from the model: an extension's slash command reporting back,
   * for instance.
   */
  notice: (text: string) => void
  /** Emit the closing `finish-step` / `finish` pair with usage metadata. */
  finish: (summary: TurnSummary) => void
  /** Emit a terminal error chunk (turn failed before/while streaming). */
  fail: (message: string) => void
}

/** Pi reports compaction through events; the UI renders it as this tool name. */
export const COMPACTION_TOOL_NAME = 'compaction'

function textFromToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (typeof result !== 'object' || result === null) return ''
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n')
}

/**
 * A tool call being dictated by the model. `toolCallId` / `toolName` can arrive
 * a chunk later than the first argument text, so deltas are buffered until the
 * UI part can be opened with a real id.
 */
type StreamingCall = {
  toolCallId?: string
  toolName?: string
  buffered: string
}

/** The tool call the given content block of a partial message holds, if any. */
function toolCallAt(
  partial: { content?: unknown[] } | undefined,
  contentIndex: number | undefined,
): { id?: string; name?: string } | undefined {
  const block = partial?.content?.[contentIndex ?? 0]
  if (typeof block !== 'object' || block === null) return undefined
  const candidate = block as { type?: unknown; id?: unknown; name?: unknown }
  if (candidate.type !== 'toolCall') return undefined
  return {
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : undefined,
    name: typeof candidate.name === 'string' && candidate.name ? candidate.name : undefined,
  }
}

export function createStreamTranslator(options: StreamTranslatorOptions): StreamTranslator {
  const { emit, onToolProgress } = options
  const now = options.now ?? Date.now

  // Pi restarts content indices per message, so scope block ids by message.
  let messageIndex = 0
  let started = false
  let stepOpen = false
  // Open text/reasoning block ids, so an unterminated block can still be closed
  // when the message ends (a provider can drop the closing event on abort).
  const openBlocks = new Map<string, 'text' | 'reasoning'>()
  // Wall-clock start of each open reasoning block. Pi's events carry no timing,
  // so the durations the UI shows ("Reasoned for 4.2 seconds") are measured
  // here and travel as provider metadata on the reasoning part — which persists
  // with the transcript, so a restored session keeps them. Same `aipg` keys
  // Chat mode stamps, so both surfaces read timings the same way.
  const reasoningStarts = new Map<string, number>()
  const toolNames = new Map<string, string>()
  // Tool calls whose arguments are still streaming from the model, keyed by
  // message + content index (Pi's toolcall_* events identify the block, not the
  // call). Dropped once the call starts executing.
  const streamingCalls = new Map<string, StreamingCall>()

  const blockId = (kind: 'text' | 'reasoning', contentIndex: number | undefined) =>
    `${kind}-${messageIndex}-${contentIndex ?? 0}`

  function ensureStarted(): void {
    if (started) return
    started = true
    emit({ type: 'start' })
  }

  function ensureStep(): void {
    ensureStarted()
    if (stepOpen) return
    stepOpen = true
    emit({ type: 'start-step' })
  }

  function openBlock(kind: 'text' | 'reasoning', contentIndex: number | undefined): string {
    const id = blockId(kind, contentIndex)
    if (!openBlocks.has(id)) {
      openBlocks.set(id, kind)
      if (kind === 'reasoning') {
        const startedAt = now()
        reasoningStarts.set(id, startedAt)
        // Already on the start chunk, so the timer of a block that is still
        // streaming counts from its real start rather than from its end.
        emit({ type: 'reasoning-start', id, providerMetadata: timing(startedAt) })
        return id
      }
      emit({ type: `${kind}-start`, id })
    }
    return id
  }

  function timing(startedAt: number, finishedAt?: number): StreamChunk {
    return {
      aipg: {
        reasoningStarted: startedAt,
        ...(finishedAt === undefined ? {} : { reasoningFinished: finishedAt }),
      },
    }
  }

  function endChunk(kind: 'text' | 'reasoning', id: string): StreamChunk {
    const startedAt = reasoningStarts.get(id)
    if (startedAt === undefined) return { type: `${kind}-end`, id }
    reasoningStarts.delete(id)
    return { type: `${kind}-end`, id, providerMetadata: timing(startedAt, now()) }
  }

  function closeBlock(kind: 'text' | 'reasoning', contentIndex: number | undefined): void {
    const id = blockId(kind, contentIndex)
    if (!openBlocks.delete(id)) return
    emit(endChunk(kind, id))
  }

  function closeAllBlocks(): void {
    for (const [id, kind] of openBlocks) emit(endChunk(kind, id))
    openBlocks.clear()
  }

  // llama.cpp (and other OpenAI-compat providers) only emit `thinking_end` after
  // the whole completion finishes — including minutes of tool-call dictation.
  // Close reasoning as soon as other content starts so the live timer and the
  // persisted duration stop with the thinking, not with the message.
  function closeOpenReasoning(): void {
    for (const [id, kind] of [...openBlocks]) {
      if (kind !== 'reasoning') continue
      openBlocks.delete(id)
      emit(endChunk(kind, id))
    }
  }

  // Opening the UI part needs both ids, so a call stays buffered until the
  // provider has named it; from then on argument text flows straight through.
  function pushToolCallText(event: AssistantMessageEvent): void {
    const key = `${messageIndex}-${event.contentIndex ?? 0}`
    const call = streamingCalls.get(key) ?? { buffered: '' }
    streamingCalls.set(key, call)
    const identity = toolCallAt(event.partial, event.contentIndex) ?? event.toolCall
    const opened = !!call.toolCallId
    if (!opened && identity?.id && identity.name) {
      call.toolCallId = identity.id
      call.toolName = identity.name
      toolNames.set(identity.id, identity.name)
      emit({
        type: 'tool-input-start',
        toolCallId: identity.id,
        toolName: identity.name,
        dynamic: true,
      })
    }
    const text = (opened ? '' : call.buffered) + (event.delta ?? '')
    if (!call.toolCallId) {
      call.buffered = text
      return
    }
    call.buffered = ''
    if (!text) return
    emit({ type: 'tool-input-delta', toolCallId: call.toolCallId, inputTextDelta: text })
  }

  /** Drop the streaming entry for a call that has reached a terminal state. */
  function endToolCallStream(toolCallId: string): void {
    for (const [key, call] of streamingCalls) {
      if (call.toolCallId === toolCallId) streamingCalls.delete(key)
    }
  }

  // A call whose arguments streamed but which never executed (the turn was
  // aborted mid-dictation) would otherwise sit in the UI as forever-preparing.
  function failPendingToolCalls(reason: string): void {
    for (const call of streamingCalls.values()) {
      if (!call.toolCallId) continue
      emit({
        type: 'tool-input-error',
        toolCallId: call.toolCallId,
        toolName: call.toolName ?? 'unknown',
        input: {},
        errorText: reason,
        dynamic: true,
      })
    }
    streamingCalls.clear()
  }

  function handleAssistantEvent(event: AssistantMessageEvent): void {
    switch (event.type) {
      case 'text_start':
        ensureStep()
        closeOpenReasoning()
        openBlock('text', event.contentIndex)
        break
      case 'text_delta': {
        ensureStep()
        closeOpenReasoning()
        const id = openBlock('text', event.contentIndex)
        emit({ type: 'text-delta', id, delta: event.delta ?? '' })
        break
      }
      case 'text_end':
        closeBlock('text', event.contentIndex)
        break
      case 'thinking_start':
        ensureStep()
        openBlock('reasoning', event.contentIndex)
        break
      case 'thinking_delta': {
        ensureStep()
        const id = openBlock('reasoning', event.contentIndex)
        emit({ type: 'reasoning-delta', id, delta: event.delta ?? '' })
        break
      }
      case 'thinking_end':
        closeBlock('reasoning', event.contentIndex)
        break
      // Dictating a tool call can take minutes on its own (a `write` carries the
      // whole file in its arguments), so the call is shown as it streams rather
      // than only once tool_execution_start fires.
      case 'toolcall_start':
      case 'toolcall_delta':
        ensureStep()
        closeOpenReasoning()
        pushToolCallText(event)
        break
      case 'toolcall_end':
        // Nothing to settle here: tool_execution_start turns the part into a
        // running call, and an unexecuted call is settled at turn end.
        break
      default:
        break
    }
  }

  function handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'agent_start':
        ensureStarted()
        break
      case 'turn_start':
        ensureStep()
        break
      case 'message_start':
        messageIndex += 1
        break
      case 'message_update':
        handleAssistantEvent(event.assistantMessageEvent as AssistantMessageEvent)
        break
      case 'message_end':
        closeAllBlocks()
        break
      case 'tool_execution_start': {
        ensureStep()
        closeOpenReasoning()
        toolNames.set(event.toolCallId, event.toolName)
        endToolCallStream(event.toolCallId)
        emit({
          type: 'tool-input-available',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args ?? {},
          dynamic: true,
        })
        break
      }
      case 'tool_execution_update': {
        // Streaming tool progress is not part of the UI message protocol, so it
        // travels on its own channel and is merged into the tool part by id.
        const text = textFromToolResult(event.partialResult)
        if (text && onToolProgress) {
          onToolProgress({ toolCallId: event.toolCallId, toolName: event.toolName, text })
        }
        break
      }
      case 'tool_execution_end': {
        endToolCallStream(event.toolCallId)
        const output = event.result
        if (event.isError) {
          emit({
            type: 'tool-output-error',
            toolCallId: event.toolCallId,
            errorText: textFromToolResult(output) || 'Tool execution failed.',
            dynamic: true,
          })
        } else {
          emit({
            type: 'tool-output-available',
            toolCallId: event.toolCallId,
            output,
            dynamic: true,
          })
        }
        break
      }
      case 'compaction_start':
        // The result (and its token counts) only exists at compaction_end, so a
        // part here would have to be revised; report the finished compaction.
        break
      case 'compaction_end': {
        // Rendered as a synthetic tool call/result pair, matching how the UI
        // already displays compaction. Unlike the harness projection, these
        // token counts are Pi's real before/after figures.
        const callId = `compaction-${messageIndex}-${Date.now()}`
        emit({
          type: 'tool-input-available',
          toolCallId: callId,
          toolName: COMPACTION_TOOL_NAME,
          input: { reason: event.reason },
          dynamic: true,
        })
        if (event.aborted || event.errorMessage) {
          emit({
            type: 'tool-output-error',
            toolCallId: callId,
            errorText: event.errorMessage ?? 'Compaction aborted.',
            dynamic: true,
          })
          break
        }
        emit({
          type: 'tool-output-available',
          toolCallId: callId,
          output: {
            trigger: event.reason,
            summary: event.result?.summary,
            tokensBefore: event.result?.tokensBefore,
            tokensAfter: event.result?.estimatedTokensAfter,
          },
          dynamic: true,
        })
        break
      }
      default:
        // queue_update / thinking_level_changed / session_info_changed /
        // auto_retry_* carry no transcript content — the manager logs and
        // reports those separately.
        break
    }
  }

  // Usage and context occupancy ride along as message metadata (the renderer
  // reads them off the assistant message — see the agentMode store's
  // sessionUsage / contextUsage). `message-metadata` chunks merge into the
  // message that is still streaming, which is what keeps the gauge live.
  function update(summary: TurnSummary): void {
    ensureStarted()
    emit({ type: 'message-metadata', messageMetadata: summary })
  }

  // Its own block id, outside the model's `messageIndex` numbering, so it can
  // never collide with a text part the model is streaming at the same time.
  let noticeCount = 0
  function notice(text: string): void {
    if (!text) return
    ensureStep()
    const id = `notice-${(noticeCount += 1)}`
    emit({ type: 'text-start', id })
    emit({ type: 'text-delta', id, delta: text })
    emit({ type: 'text-end', id })
  }

  function finish(summary: TurnSummary): void {
    ensureStarted()
    closeAllBlocks()
    failPendingToolCalls('Tool call was not executed.')
    if (stepOpen) {
      stepOpen = false
      emit({ type: 'finish-step' })
    }
    emit({ type: 'finish', messageMetadata: summary })
  }

  function fail(message: string): void {
    closeAllBlocks()
    failPendingToolCalls('Turn ended before the tool call ran.')
    emit({ type: 'error', errorText: message })
  }

  return { handle, update, notice, finish, fail }
}
