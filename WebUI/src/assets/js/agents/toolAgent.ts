import { isStepCount, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'

// ── Tool agent factory ────────────────────────────────────────────────────────
//
// Generic building block for "tool delegation": a heavy tool family (large /
// dynamic schemas, chatty intermediate results) runs inside a nested
// `streamText` tool loop, and the parent agent (Chat or Agent Mode) only ever
// sees one thin delegating tool plus the final summary. The nested loop's tool
// schemas, calls and results never enter the parent context.
//
// The run is streamed rather than generated in one shot purely for
// observability: delegated work takes minutes, so callers get `ToolAgentEvent`s
// (phase changes, narration deltas, tool start/finish) to render a live
// timeline. The resolved result is the same either way.
//
// This module is deliberately free of store/app imports so it can be unit
// tested in a plain node environment; the domain wiring (which tools, which
// system prompt, how results are condensed) lives with each concrete agent
// (see mediaAgent.ts).

export type ToolAgentStep = {
  toolName: string
  input: unknown
  output: unknown
}

/**
 * Progress signals for a nested run. Emitted in real time so a UI can show
 * what the sub-agent is doing while the parent tool call is still pending.
 */
export type ToolAgentEvent =
  | { type: 'phase'; phase: ToolAgentPhase }
  | { type: 'narration-delta'; kind: 'reasoning' | 'text'; text: string }
  | { type: 'tool-start'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-finish'; toolCallId: string; output: unknown; error?: string }

/**
 * `planning` = the model is deciding (or narrating) between tool calls,
 * `running-tool` = a tool execution is in flight.
 */
export type ToolAgentPhase = 'planning' | 'running-tool'

export type ToolAgentResult = {
  /** The nested agent's final text (its report about what it did). */
  text: string
  /** Every tool call the nested agent made, in order. */
  steps: ToolAgentStep[]
}

export type ToolAgentConfig = {
  /** Diagnostic name (log prefix). */
  name: string
  /** System prompt, built per run so it can carry dynamic catalogs. */
  system: () => string
  /** Tool set, resolved per run (schemas can depend on live app state). */
  tools: () => ToolSet
  /** LLM-step cap for the nested loop (a tool round trip is one step). */
  maxSteps?: number
}

export type ToolAgentRunOptions = {
  model: LanguageModel
  /** The delegated request, verbatim from the parent agent. */
  request: string
  /**
   * Optional extra messages placed before the request (e.g. a user message
   * carrying a source image for the inner tools to discover).
   */
  priorMessages?: ModelMessage[]
  abortSignal?: AbortSignal
  /** Forwarded to streamText's experimental_repairToolCall. */
  repairToolCall?: Parameters<typeof streamText>[0]['experimental_repairToolCall']
  /** Live progress sink; see ToolAgentEvent. */
  onEvent?: (event: ToolAgentEvent) => void
}

const DEFAULT_MAX_STEPS = 6

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createToolAgent(config: ToolAgentConfig) {
  async function run(options: ToolAgentRunOptions): Promise<ToolAgentResult> {
    const messages: ModelMessage[] = [
      ...(options.priorMessages ?? []),
      { role: 'user', content: options.request },
    ]
    const emit = options.onEvent ?? (() => {})

    const result = streamText({
      model: options.model,
      system: config.system(),
      messages,
      tools: config.tools(),
      stopWhen: isStepCount(config.maxSteps ?? DEFAULT_MAX_STEPS),
      abortSignal: options.abortSignal,
      experimental_repairToolCall: options.repairToolCall,
      onToolExecutionStart: ({ toolCall }) => {
        emit({ type: 'phase', phase: 'running-tool' })
        emit({
          type: 'tool-start',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        })
      },
      onToolExecutionEnd: ({ toolCall, toolOutput }) => {
        emit({
          type: 'tool-finish',
          toolCallId: toolCall.toolCallId,
          output: toolOutput.type === 'tool-result' ? toolOutput.output : undefined,
          error: toolOutput.type === 'tool-error' ? errorMessage(toolOutput.error) : undefined,
        })
      },
    })

    // streamText reports failures as `error` parts instead of rejecting, so
    // collect them here and rethrow below — callers (and the media tool's
    // failure reporting) rely on a throw.
    let streamError: unknown = null
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'start-step':
          emit({ type: 'phase', phase: 'planning' })
          break
        case 'reasoning-delta':
          emit({ type: 'narration-delta', kind: 'reasoning', text: part.text })
          break
        case 'text-delta':
          emit({ type: 'narration-delta', kind: 'text', text: part.text })
          break
        case 'error':
          streamError = part.error
          break
      }
    }
    if (streamError !== null) {
      throw streamError instanceof Error ? streamError : new Error(errorMessage(streamError))
    }

    const steps: ToolAgentStep[] = (await result.steps).flatMap((step) =>
      step.toolResults.map((toolResult) => ({
        toolName: toolResult.toolName,
        input: toolResult.input,
        output: toolResult.output,
      })),
    )
    console.info(`[${config.name}] finished with ${steps.length} tool call(s)`)
    return { text: await result.text, steps }
  }

  return { name: config.name, run }
}
