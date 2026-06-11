import { describe, it, expect } from 'vitest'
import { completeOrphanedToolParts } from './toolMessageSanitize'
import type { AipgUiMessage } from './openAiCompatibleChat'

// The helper only inspects `role`, `parts[].type`, and `parts[].state`, so the
// fixtures below are intentionally loose and cast to the message type.
const msg = (role: string, parts: unknown[]): AipgUiMessage =>
  ({ id: 'm', role, parts }) as unknown as AipgUiMessage

describe('completeOrphanedToolParts', () => {
  it('completes an orphaned tool call (input-available) with an output-error', () => {
    const input = [
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [{ type: 'tool-browseWeb', toolCallId: 'c1', state: 'input-available', input: {} }]),
    ]
    const out = completeOrphanedToolParts(input)
    expect(out).not.toBe(input) // changed → new reference
    const part = out[1].parts[0] as { state: string; errorText: string }
    expect(part.state).toBe('output-error')
    expect(part.errorText).toMatch(/did not complete/i)
  })

  it('completes orphaned dynamic-tool and input-streaming parts', () => {
    const out = completeOrphanedToolParts([
      msg('assistant', [{ type: 'dynamic-tool', toolName: 'mcp', toolCallId: 'c2', state: 'input-streaming' }]),
    ])
    expect((out[0].parts[0] as { state: string }).state).toBe('output-error')
  })

  it('leaves completed tool parts and non-tool parts untouched (same reference)', () => {
    const input = [
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [
        { type: 'text', text: 'done' },
        { type: 'tool-comfyUI', toolCallId: 'c3', state: 'output-available', output: { ok: true } },
        { type: 'tool-comfyUI', toolCallId: 'c4', state: 'output-error', errorText: 'boom' },
      ]),
    ]
    const out = completeOrphanedToolParts(input)
    expect(out).toBe(input) // nothing changed → same reference
  })

  it('preserves sibling parts when repairing one orphan in the same message', () => {
    const out = completeOrphanedToolParts([
      msg('assistant', [
        { type: 'text', text: 'let me search' },
        { type: 'tool-searchWeb', toolCallId: 'c5', state: 'input-available' },
      ]),
    ])
    expect((out[0].parts[0] as { type: string }).type).toBe('text')
    expect((out[0].parts[1] as { state: string }).state).toBe('output-error')
  })
})