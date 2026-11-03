import { describe, expect, it } from 'vitest'
import { chatTimelineItems, timelineTurns, withLiveAgentTurn } from '@/lib/sessionTimeline'

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

const chatMessage = (id: string, role: 'user' | 'assistant', text: string) => ({
  id,
  role,
  parts: [{ type: 'text', text }],
  metadata: { chatTurn: true },
})

describe('Task Runs in the timeline', () => {
  const taskRunTag = {
    presetName: 'Agent',
    harnessSessionId: 'aipg-agent-run',
    taskRun: { taskName: 'Morning digest', startedAt: 500 },
  }
  const runMessage = (id: string, role: 'user' | 'assistant') => ({
    id,
    role,
    parts: [{ type: 'text', text: id }],
    metadata: { agentTurn: taskRunTag },
  })

  it("groups a run's Steps under its Task name and start time, apart from the Agent's own turns", () => {
    const turns = timelineTurns([
      agentMessage('u1', 'user', 'hello'),
      agentMessage('a1', 'assistant', 'hi'),
      runMessage('r1', 'user'),
      runMessage('r2', 'assistant'),
      runMessage('r3', 'user'),
      runMessage('r4', 'assistant'),
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0]).not.toHaveProperty('taskRun')
    expect(turns[1]).toMatchObject({
      kind: 'agent',
      taskRun: { taskName: 'Morning digest', startedAt: 500 },
    })
    expect(turns[1].kind === 'agent' && turns[1].messages.map((message) => message.id)).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
    ])
  })
})

describe('chat turns in the timeline', () => {
  it('keeps a run of the chat transcript together as one chat block', () => {
    const turns = timelineTurns([
      chatMessage('u1', 'user', 'hi'),
      chatMessage('a1', 'assistant', 'hello'),
      mediaPrompt,
      mediaCard,
      chatMessage('u2', 'user', 'describe it'),
      chatMessage('a2', 'assistant', 'a fox'),
    ])

    expect(turns.map((turn) => turn.kind)).toEqual(['chat', 'media', 'chat'])
    const last = turns.at(-1)
    expect(last?.kind === 'chat' && last.messages.map((message) => message.id)).toEqual([
      'u2',
      'a2',
    ])
  })
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

describe('the live agent turn in the Session timeline', () => {
  const live = (id: string, role: 'user' | 'assistant', text: string) => ({
    id,
    role,
    parts: [{ type: 'text', text }],
  })

  it('streams the running turn after everything the Session already settled', () => {
    const timeline = withLiveAgentTurn(
      [agentMessage('u1', 'user', 'describe it'), agentMessage('a1', 'assistant', 'a castle')],
      agentTurn,
      [
        live('u1', 'user', 'describe it'),
        live('a1', 'assistant', 'a castle'),
        live('u2', 'user', 'make it blue'),
        live('a2', 'assistant', 'paint'),
      ],
    )

    const turns = timelineTurns(timeline)
    expect(turns.map((turn) => turn.kind)).toEqual(['agent'])
    expect(turns[0].kind === 'agent' && turns[0].messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ])
  })

  it('shows the streaming copy of a message the Session saved earlier in the turn', () => {
    const timeline = withLiveAgentTurn(
      [mediaPrompt, mediaCard, agentMessage('u2', 'user', 'make it blue')],
      agentTurn,
      [live('u2', 'user', 'make it blue'), live('a2', 'assistant', 'painting…')],
    )

    const turns = timelineTurns(timeline)
    expect(turns.map((turn) => turn.kind)).toEqual(['media', 'agent'])
    const agent = turns[1]
    expect(agent.kind === 'agent' && agent.messages.map((message) => message.id)).toEqual([
      'u2',
      'a2',
    ])
  })

  it('leaves the timeline as it is with nothing live', () => {
    const timeline = [mediaPrompt, mediaCard]
    expect(withLiveAgentTurn(timeline, agentTurn, [])).toEqual(timeline)
  })
})

describe('Chat mode over the Session timeline', () => {
  const live = (id: string, role: 'user' | 'assistant', text: string) => ({
    id,
    role,
    parts: [{ type: 'text', text }],
  })

  it("puts the live conversation where the Session's chat turns are, other turns between", () => {
    const items = chatTimelineItems(
      [
        chatMessage('u1', 'user', 'hi'),
        chatMessage('a1', 'assistant', 'hello'),
        mediaPrompt,
        mediaCard,
        agentMessage('g1', 'user', 'tidy up'),
      ],
      [
        live('u1', 'user', 'hi'),
        live('a1', 'assistant', 'hello'),
        live('u2', 'user', 'describe it'),
        live('a2', 'assistant', 'a f'),
      ],
    )

    expect(
      items.map((item) =>
        item.kind === 'message' ? `${item.message.id}@${item.index}` : item.turn.kind,
      ),
    ).toEqual(['u1@0', 'a1@1', 'media', 'agent', 'u2@2', 'a2@3'])
  })

  it('shows only the conversation when the Session holds nothing else', () => {
    const items = chatTimelineItems([], [live('u1', 'user', 'hi')])
    expect(items).toEqual([{ kind: 'message', message: live('u1', 'user', 'hi'), index: 0 }])
  })
})
