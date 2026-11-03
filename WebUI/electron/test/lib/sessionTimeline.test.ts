import { describe, expect, it } from 'vitest'
import { timelineTurns } from '@/lib/sessionTimeline'

const agentTurn = { presetName: 'Agent', harnessSessionId: 'aipg-agent-1' }

function agentMessage(id: string, role: 'user' | 'assistant', text: string) {
  return { id, role, parts: [{ type: 'text', text }], metadata: { agentTurn } }
}

const mediaPrompt = {
  id: 'p1',
  role: 'user',
  createdAt: 1,
  parts: [{ type: 'text', text: 'a castle' }],
}
const mediaCard = {
  id: 'c1',
  role: 'assistant',
  createdAt: 1,
  parts: [
    {
      type: 'data-media',
      data: { runId: 'r1', mode: 'imageGen', preset: 'Draft', status: 'completed', items: [] },
    },
  ],
}

describe('Session timeline turns', () => {
  it('keeps consecutive messages of one Harness Session together as one agent block', () => {
    const turns = timelineTurns([
      mediaPrompt,
      mediaCard,
      agentMessage('u1', 'user', 'describe it'),
      agentMessage('a1', 'assistant', 'a castle'),
      agentMessage('u2', 'user', 'make it blue'),
      agentMessage('a2', 'assistant', 'done'),
    ])

    expect(turns.map((turn) => turn.kind)).toEqual(['media', 'agent'])
    const agent = turns[1]
    expect(agent).toMatchObject({ kind: 'agent', presetName: 'Agent' })
    if (agent.kind !== 'agent') throw new Error('not an agent block')
    expect(agent.messages.map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('starts a new agent block after a turn of another preset', () => {
    const turns = timelineTurns([
      agentMessage('u1', 'user', 'hello'),
      agentMessage('a1', 'assistant', 'hi'),
      mediaPrompt,
      mediaCard,
      agentMessage('u2', 'user', 'and now?'),
    ])

    expect(turns.map((turn) => turn.kind)).toEqual(['agent', 'media', 'agent'])
  })
})

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
