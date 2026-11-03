import { describe, expect, it } from 'vitest'
import { timelineTurns } from '@/lib/sessionTimeline'

const user = (id: string, text: string) => ({
  id,
  role: 'user',
  createdAt: 1,
  parts: [{ type: 'text', text }],
})

describe('timelineTurns', () => {
  it('pairs a prompt with its audio result into one audio turn', () => {
    const audio = { kind: 'tts', preset: 'Text to Speech', status: 'completed', audioUrl: 'u' }
    const turns = timelineTurns([
      user('u1', 'Read this'),
      { id: 'a1', role: 'assistant', createdAt: 2, parts: [{ type: 'data-audio', data: audio }] },
    ])

    expect(turns).toEqual([{ kind: 'audio', id: 'a1', prompt: 'Read this', createdAt: 1, audio }])
  })

  it('keeps a prompt with a plain text answer as two messages', () => {
    const turns = timelineTurns([
      user('u1', 'hi'),
      { id: 'a1', role: 'assistant', createdAt: 2, parts: [{ type: 'text', text: 'hello' }] },
    ])

    expect(turns.map((turn) => turn.kind)).toEqual(['message', 'message'])
  })
})
