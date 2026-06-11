import type { AipgUiMessage } from './openAiCompatibleChat'

/**
 * Repair orphaned tool calls in a UI message history.
 *
 * A turn that is interrupted (manual stop, abort, HMR reload) or whose tool
 * `execute` never returns can leave an assistant tool part stuck in an
 * `input-*` state — the model asked to call a tool but no result was ever
 * recorded. Once such a message is persisted, every subsequent generation
 * rebuilds the history, `convertToModelMessages` emits a tool-call with no
 * matching tool-result, and `streamText` throws "Tool result is missing for
 * tool call …" before the first step runs. The thread is permanently bricked.
 *
 * We *complete* each orphan with a synthetic `output-error` result rather than
 * dropping it: the call/result pair becomes structurally valid, the model gets
 * a coherent "that tool failed" signal, and a message that contained only the
 * tool call does not collapse into an empty (invalid) assistant message.
 *
 * Note: in the AI SDK v6 UI-message model a tool call and its result share a
 * single part (the `state` transitions input → output), so there is no separate
 * "orphaned tool-result" case to handle here.
 *
 * Pure: returns the same array reference when nothing changed, and only clones
 * the messages/parts it actually rewrites, to avoid spurious reactivity churn.
 */
const ORPHAN_ERROR_TEXT = 'Tool call did not complete (interrupted).'

function isOrphanedToolPart(part: { type: string; state?: string }): boolean {
  const isToolPart = part.type.startsWith('tool-') || part.type === 'dynamic-tool'
  return isToolPart && (part.state === 'input-streaming' || part.state === 'input-available')
}

export function completeOrphanedToolParts(messages: AipgUiMessage[]): AipgUiMessage[] {
  let changed = false
  const result = messages.map((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.parts)) return message
    let messageChanged = false
    const parts = message.parts.map((part) => {
      if (!isOrphanedToolPart(part as { type: string; state?: string })) return part
      messageChanged = true
      return {
        ...part,
        state: 'output-error',
        errorText: ORPHAN_ERROR_TEXT,
      } as (typeof message.parts)[number]
    })
    if (!messageChanged) return message
    changed = true
    return { ...message, parts }
  })
  return changed ? result : messages
}