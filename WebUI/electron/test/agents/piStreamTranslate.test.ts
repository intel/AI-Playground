import { describe, expect, it } from 'vitest'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import {
  COMPACTION_TOOL_NAME,
  createStreamTranslator,
  type StreamChunk,
} from '../../agentMode/piStreamTranslate'

// Unit tests for the Pi event stream → AI SDK UI message chunk translation.
// This is the contract the whole Agent Mode UI is built on: the renderer feeds
// these chunks straight into an @ai-sdk/vue `Chat`, so a wrong id or a missing
// `*-end` chunk breaks rendering with no error anywhere. Events are written as
// the real `AgentSessionEvent` shapes and asserted against chunk sequences.

type Recorded = { chunks: StreamChunk[]; progress: ProgressUpdate[] }
type ProgressUpdate = { toolCallId: string; toolName: string; text: string }

function run(events: AgentSessionEvent[], now?: () => number): Recorded {
  const chunks: StreamChunk[] = []
  const progress: ProgressUpdate[] = []
  const translator = createStreamTranslator({
    emit: (chunk) => chunks.push(chunk),
    onToolProgress: (update) => progress.push(update),
    now,
  })
  for (const event of events) translator.handle(event)
  return { chunks, progress }
}

/** A clock that advances by the given step on every reading. */
function clockFrom(start: number, step: number): () => number {
  let value = start - step
  return () => (value += step)
}

function types(chunks: StreamChunk[]): string[] {
  return chunks.map((chunk) => String(chunk.type))
}

/** A Pi assistant-message event, wrapped as the session event carrying it. */
function message(assistantMessageEvent: Record<string, unknown>): AgentSessionEvent {
  return { type: 'message_update', assistantMessageEvent } as unknown as AgentSessionEvent
}

const turnStart = { type: 'turn_start' } as unknown as AgentSessionEvent
const messageStart = { type: 'message_start' } as unknown as AgentSessionEvent
const messageEnd = { type: 'message_end' } as unknown as AgentSessionEvent

describe('createStreamTranslator', () => {
  it('translates a text-only turn into a well-formed chunk sequence', () => {
    const { chunks } = run([
      turnStart,
      messageStart,
      message({ type: 'text_start', contentIndex: 0 }),
      message({ type: 'text_delta', contentIndex: 0, delta: 'Hel' }),
      message({ type: 'text_delta', contentIndex: 0, delta: 'lo' }),
      message({ type: 'text_end', contentIndex: 0 }),
      messageEnd,
    ])

    expect(types(chunks)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
    ])
    // All chunks of one block must share an id, or the renderer starts a new part.
    const ids = new Set(chunks.slice(2).map((chunk) => chunk.id))
    expect(ids.size).toBe(1)
    expect(
      chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta),
    ).toEqual(['Hel', 'lo'])
  })

  it('maps thinking deltas to reasoning chunks with their own id', () => {
    const { chunks } = run([
      turnStart,
      messageStart,
      message({ type: 'thinking_start', contentIndex: 0 }),
      message({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }),
      message({ type: 'thinking_end', contentIndex: 0 }),
      message({ type: 'text_start', contentIndex: 1 }),
      message({ type: 'text_delta', contentIndex: 1, delta: 'done' }),
      message({ type: 'text_end', contentIndex: 1 }),
      messageEnd,
    ])

    expect(types(chunks)).toEqual([
      'start',
      'start-step',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
    ])
    expect(chunks[2].id).not.toBe(chunks[5].id)
  })

  // Pi's events carry no timing, so the translator measures how long each
  // thinking block ran and ships it as provider metadata — which persists with
  // the message, so a restored session can still say "Reasoned for 2.5 seconds"
  // instead of showing an untimed trace.
  it('stamps reasoning blocks with the wall clock they ran for', () => {
    const { chunks } = run(
      [
        turnStart,
        messageStart,
        message({ type: 'thinking_start', contentIndex: 0 }),
        message({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }),
        message({ type: 'thinking_end', contentIndex: 0 }),
        messageEnd,
      ],
      clockFrom(1_000, 2_500),
    )

    const started = chunks.find((chunk) => chunk.type === 'reasoning-start')
    const ended = chunks.find((chunk) => chunk.type === 'reasoning-end')
    // On the start chunk too, so the live timer counts from the real start.
    expect(started?.providerMetadata).toEqual({ aipg: { reasoningStarted: 1_000 } })
    expect(ended?.providerMetadata).toEqual({
      aipg: { reasoningStarted: 1_000, reasoningFinished: 3_500 },
    })
  })

  it('times a reasoning block that only gets closed when the message ends', () => {
    const { chunks } = run(
      [
        turnStart,
        messageStart,
        message({ type: 'thinking_delta', contentIndex: 0, delta: 'cut off' }),
        messageEnd,
      ],
      clockFrom(1_000, 500),
    )

    expect(chunks.at(-1)).toEqual({
      type: 'reasoning-end',
      id: expect.any(String),
      providerMetadata: { aipg: { reasoningStarted: 1_000, reasoningFinished: 1_500 } },
    })
  })

  // llama.cpp only emits thinking_end after the whole completion, so a write's
  // argument stream would otherwise be counted as thinking. Close as soon as
  // non-reasoning content starts, and ignore the late thinking_end.
  it('stops the reasoning clock when the model starts dictating a tool call', () => {
    const partial = {
      content: [{ type: 'thinking' }, { type: 'toolCall', id: 'call-1', name: 'write' }],
    }
    const { chunks } = run(
      [
        turnStart,
        messageStart,
        message({ type: 'thinking_start', contentIndex: 0 }),
        message({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }),
        message({ type: 'toolcall_start', contentIndex: 1, partial }),
        message({
          type: 'toolcall_delta',
          contentIndex: 1,
          delta: '{"path":"a.txt"}',
          partial,
        }),
        message({ type: 'thinking_end', contentIndex: 0 }),
        messageEnd,
      ],
      clockFrom(1_000, 500),
    )

    const typesList = types(chunks)
    expect(typesList.filter((type) => type === 'reasoning-end')).toHaveLength(1)
    expect(typesList.indexOf('reasoning-end')).toBeLessThan(typesList.indexOf('tool-input-start'))
    expect(chunks.find((chunk) => chunk.type === 'reasoning-end')).toEqual({
      type: 'reasoning-end',
      id: expect.any(String),
      providerMetadata: { aipg: { reasoningStarted: 1_000, reasoningFinished: 1_500 } },
    })
  })

  it('stops the reasoning clock when a tool starts executing without a streamed call', () => {
    const { chunks } = run(
      [
        turnStart,
        messageStart,
        message({ type: 'thinking_start', contentIndex: 0 }),
        message({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }),
        {
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'bash',
          args: { command: 'ls' },
        } as unknown as AgentSessionEvent,
        message({ type: 'thinking_end', contentIndex: 0 }),
        messageEnd,
      ],
      clockFrom(1_000, 500),
    )

    const typesList = types(chunks)
    expect(typesList.filter((type) => type === 'reasoning-end')).toHaveLength(1)
    expect(typesList.indexOf('reasoning-end')).toBeLessThan(
      typesList.indexOf('tool-input-available'),
    )
    expect(chunks.find((chunk) => chunk.type === 'reasoning-end')?.providerMetadata).toEqual({
      aipg: { reasoningStarted: 1_000, reasoningFinished: 1_500 },
    })
  })

  it('stops the reasoning clock when the model starts writing the answer', () => {
    const { chunks } = run(
      [
        turnStart,
        messageStart,
        message({ type: 'thinking_start', contentIndex: 0 }),
        message({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }),
        message({ type: 'text_start', contentIndex: 1 }),
        message({ type: 'text_delta', contentIndex: 1, delta: 'done' }),
        message({ type: 'thinking_end', contentIndex: 0 }),
        messageEnd,
      ],
      clockFrom(1_000, 500),
    )

    const typesList = types(chunks)
    expect(typesList.filter((type) => type === 'reasoning-end')).toHaveLength(1)
    expect(typesList.indexOf('reasoning-end')).toBeLessThan(typesList.indexOf('text-start'))
    expect(chunks.find((chunk) => chunk.type === 'reasoning-end')?.providerMetadata).toEqual({
      aipg: { reasoningStarted: 1_000, reasoningFinished: 1_500 },
    })
  })

  it('keeps block ids unique across messages that reuse content indices', () => {
    const { chunks } = run([
      turnStart,
      messageStart,
      message({ type: 'text_start', contentIndex: 0 }),
      message({ type: 'text_delta', contentIndex: 0, delta: 'first' }),
      message({ type: 'text_end', contentIndex: 0 }),
      messageEnd,
      messageStart,
      message({ type: 'text_start', contentIndex: 0 }),
      message({ type: 'text_delta', contentIndex: 0, delta: 'second' }),
      message({ type: 'text_end', contentIndex: 0 }),
      messageEnd,
    ])

    const startIds = chunks.filter((chunk) => chunk.type === 'text-start').map((chunk) => chunk.id)
    expect(startIds).toHaveLength(2)
    expect(startIds[0]).not.toBe(startIds[1])
  })

  it('closes a block left open when a message ends', () => {
    const { chunks } = run([
      turnStart,
      messageStart,
      message({ type: 'text_start', contentIndex: 0 }),
      message({ type: 'text_delta', contentIndex: 0, delta: 'cut off' }),
      messageEnd,
    ])

    expect(types(chunks)).toEqual(['start', 'start-step', 'text-start', 'text-delta', 'text-end'])
  })

  it('opens a text block from a delta that arrives without its start event', () => {
    const { chunks } = run([
      turnStart,
      messageStart,
      message({ type: 'text_delta', contentIndex: 0, delta: 'orphan' }),
      messageEnd,
    ])

    expect(types(chunks)).toEqual(['start', 'start-step', 'text-start', 'text-delta', 'text-end'])
  })

  it('translates a successful tool call into input + output chunks', () => {
    const { chunks } = run([
      turnStart,
      {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
      } as unknown as AgentSessionEvent,
      {
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        isError: false,
        result: { content: [{ type: 'text', text: 'README.md' }] },
      } as unknown as AgentSessionEvent,
    ])

    expect(chunks).toEqual([
      { type: 'start' },
      { type: 'start-step' },
      {
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'bash',
        input: { command: 'ls' },
        dynamic: true,
      },
      {
        type: 'tool-output-available',
        toolCallId: 'call-1',
        output: { content: [{ type: 'text', text: 'README.md' }] },
        dynamic: true,
      },
    ])
  })

  it('translates a failed tool call into an output error with the result text', () => {
    const { chunks } = run([
      turnStart,
      {
        type: 'tool_execution_start',
        toolCallId: 'call-2',
        toolName: 'write',
        args: { path: '/etc/passwd' },
      } as unknown as AgentSessionEvent,
      {
        type: 'tool_execution_end',
        toolCallId: 'call-2',
        toolName: 'write',
        isError: true,
        result: { content: [{ type: 'text', text: 'Refusing to write outside the workspace' }] },
      } as unknown as AgentSessionEvent,
    ])

    expect(chunks.at(-1)).toEqual({
      type: 'tool-output-error',
      toolCallId: 'call-2',
      errorText: 'Refusing to write outside the workspace',
      dynamic: true,
    })
  })

  it('always produces error text for a failed tool call, even with no result', () => {
    const { chunks } = run([
      turnStart,
      {
        type: 'tool_execution_end',
        toolCallId: 'call-3',
        toolName: 'bash',
        isError: true,
        result: undefined,
      } as unknown as AgentSessionEvent,
    ])

    expect(chunks.at(-1)).toMatchObject({
      type: 'tool-output-error',
      errorText: 'Tool execution failed.',
    })
  })

  it('routes tool progress to the side channel instead of the chunk stream', () => {
    const { chunks, progress } = run([
      turnStart,
      {
        type: 'tool_execution_start',
        toolCallId: 'call-4',
        toolName: 'bash',
        args: { command: 'npm test' },
      } as unknown as AgentSessionEvent,
      {
        type: 'tool_execution_update',
        toolCallId: 'call-4',
        toolName: 'bash',
        partialResult: { content: [{ type: 'text', text: 'running 3 tests' }] },
      } as unknown as AgentSessionEvent,
    ])

    expect(progress).toEqual([{ toolCallId: 'call-4', toolName: 'bash', text: 'running 3 tests' }])
    expect(types(chunks)).toEqual(['start', 'start-step', 'tool-input-available'])
  })

  it('streams tool call arguments as they are dictated', () => {
    // A `write` of a large file spends minutes here, before the tool ever runs.
    const partial = (name: string) => ({ content: [{ type: 'toolCall', id: 'call-5', name }] })
    const { chunks } = run([
      turnStart,
      messageStart,
      message({ type: 'toolcall_start', contentIndex: 0, partial: partial('write') }),
      message({
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"path":"a.txt",',
        partial: partial('write'),
      }),
      message({
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '"content":"hi"}',
        partial: partial('write'),
      }),
      {
        type: 'tool_execution_start',
        toolCallId: 'call-5',
        toolName: 'write',
        args: { path: 'a.txt', content: 'hi' },
      } as unknown as AgentSessionEvent,
    ])

    expect(chunks).toEqual([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'tool-input-start', toolCallId: 'call-5', toolName: 'write', dynamic: true },
      { type: 'tool-input-delta', toolCallId: 'call-5', inputTextDelta: '{"path":"a.txt",' },
      { type: 'tool-input-delta', toolCallId: 'call-5', inputTextDelta: '"content":"hi"}' },
      {
        type: 'tool-input-available',
        toolCallId: 'call-5',
        toolName: 'write',
        input: { path: 'a.txt', content: 'hi' },
        dynamic: true,
      },
    ])
  })

  it('buffers argument text until the provider names the tool call', () => {
    const named = { content: [{ type: 'toolCall', id: 'call-6', name: 'bash' }] }
    const { chunks } = run([
      turnStart,
      messageStart,
      // Some providers send the arguments before the id/name pair.
      message({
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"comm',
        partial: { content: [{ type: 'toolCall', id: '', name: '' }] },
      }),
      message({ type: 'toolcall_delta', contentIndex: 0, delta: 'and":"ls"}', partial: named }),
    ])

    expect(chunks.slice(2)).toEqual([
      { type: 'tool-input-start', toolCallId: 'call-6', toolName: 'bash', dynamic: true },
      { type: 'tool-input-delta', toolCallId: 'call-6', inputTextDelta: '{"command":"ls"}' },
    ])
  })

  it('settles a streamed tool call that never ran when the turn ends', () => {
    const chunks: StreamChunk[] = []
    const translator = createStreamTranslator({ emit: (chunk) => chunks.push(chunk) })
    translator.handle(turnStart)
    translator.handle(messageStart)
    translator.handle(
      message({
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"path":"a',
        partial: { content: [{ type: 'toolCall', id: 'call-7', name: 'write' }] },
      }),
    )
    translator.fail('aborted by user')

    expect(chunks.at(-2)).toMatchObject({
      type: 'tool-input-error',
      toolCallId: 'call-7',
      toolName: 'write',
      errorText: 'Turn ended before the tool call ran.',
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'error' })
  })

  it('revises the in-flight message metadata so the context gauge can follow', () => {
    const chunks: StreamChunk[] = []
    const translator = createStreamTranslator({ emit: (chunk) => chunks.push(chunk) })
    translator.handle(turnStart)
    translator.update({ contextUsage: { tokens: 1200, contextWindow: 32768, percent: 3.7 } })

    expect(chunks.at(-1)).toEqual({
      type: 'message-metadata',
      messageMetadata: { contextUsage: { tokens: 1200, contextWindow: 32768, percent: 3.7 } },
    })
  })

  it('renders a finished compaction as a synthetic tool part with real token counts', () => {
    const { chunks } = run([
      { type: 'compaction_start', reason: 'threshold' } as unknown as AgentSessionEvent,
      {
        type: 'compaction_end',
        reason: 'threshold',
        aborted: false,
        willRetry: false,
        result: {
          summary: 'Refactored the parser.',
          tokensBefore: 90000,
          estimatedTokensAfter: 12000,
        },
      } as unknown as AgentSessionEvent,
    ])

    const input = chunks.find((chunk) => chunk.type === 'tool-input-available')
    const output = chunks.find((chunk) => chunk.type === 'tool-output-available')
    expect(input).toMatchObject({ toolName: COMPACTION_TOOL_NAME, input: { reason: 'threshold' } })
    expect(output?.output).toEqual({
      trigger: 'threshold',
      summary: 'Refactored the parser.',
      tokensBefore: 90000,
      tokensAfter: 12000,
    })
    // Call ids must match so the UI pairs them into one part.
    expect(output?.toolCallId).toBe(input?.toolCallId)
  })

  it('reports an aborted compaction as an error part', () => {
    const { chunks } = run([
      {
        type: 'compaction_end',
        reason: 'manual',
        aborted: true,
        willRetry: false,
        result: undefined,
      } as unknown as AgentSessionEvent,
    ])

    expect(chunks.at(-1)).toMatchObject({
      type: 'tool-output-error',
      errorText: 'Compaction aborted.',
    })
  })

  it('ignores events that carry no transcript content', () => {
    const { chunks } = run([
      { type: 'queue_update', queue: [] } as unknown as AgentSessionEvent,
      { type: 'thinking_level_changed', level: 'high' } as unknown as AgentSessionEvent,
      {
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 500,
        errorMessage: 'rate limited',
      } as unknown as AgentSessionEvent,
    ])

    expect(chunks).toEqual([])
  })

  it('finishes with usage and context metadata, closing any open block and step', () => {
    const chunks: StreamChunk[] = []
    const translator = createStreamTranslator({ emit: (chunk) => chunks.push(chunk) })
    translator.handle(turnStart)
    translator.handle(messageStart)
    translator.handle(message({ type: 'text_start', contentIndex: 0 }))
    translator.finish({
      usage: { inputTokens: 120, outputTokens: 30 },
      contextUsage: { tokens: 4200, contextWindow: 32768, percent: 12.8 },
    })

    expect(types(chunks)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-end',
      'finish-step',
      'finish',
    ])
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      messageMetadata: {
        usage: { inputTokens: 120, outputTokens: 30 },
        contextUsage: { tokens: 4200, contextWindow: 32768, percent: 12.8 },
      },
    })
  })

  it('still emits a start chunk when a turn finishes without producing anything', () => {
    const chunks: StreamChunk[] = []
    const translator = createStreamTranslator({ emit: (chunk) => chunks.push(chunk) })
    translator.finish({})

    expect(types(chunks)).toEqual(['start', 'finish'])
  })

  it('fails with an error chunk after closing open blocks', () => {
    const chunks: StreamChunk[] = []
    const translator = createStreamTranslator({ emit: (chunk) => chunks.push(chunk) })
    translator.handle(turnStart)
    translator.handle(messageStart)
    translator.handle(message({ type: 'text_delta', contentIndex: 0, delta: 'partial' }))
    translator.fail('backend disconnected')

    expect(types(chunks)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'error',
    ])
    expect(chunks.at(-1)).toEqual({ type: 'error', errorText: 'backend disconnected' })
  })
})
