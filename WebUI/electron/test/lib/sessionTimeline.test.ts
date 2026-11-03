import { describe, expect, it } from 'vitest'
import { sessionTimelineItems, timelineTurns, withLiveAgentTurn } from '@/lib/sessionTimeline'

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

describe('the one Session timeline with every live turn in it', () => {
  const live = (id: string, role: 'user' | 'assistant', text: string) => ({
    id,
    role,
    parts: [{ type: 'text', text }],
  })
  const pendingMedia = { runId: 'r2', prompt: 'a dragon', preset: 'Draft', mode: 'imageGen' }
  const pendingAudio = { kind: 'tts', prompt: 'read this', preset: 'Text to Speech' }
  const kinds = (items: { kind: string }[]) => items.map((item) => item.kind)

  it('shows a media run in flight after a streaming chat turn of the same Session', () => {
    const items = sessionTimelineItems([chatMessage('u1', 'user', 'hi')], {
      chat: [live('u1', 'user', 'hi'), live('a1', 'assistant', 'hel')],
      media: pendingMedia,
    })

    expect(kinds(items)).toEqual(['chat', 'pending-media'])
    expect(items[1]).toEqual({ kind: 'pending-media', id: 'r2', pending: pendingMedia })
  })

  it('shows a streaming chat turn that the Session has not saved yet, after its media turns', () => {
    const items = sessionTimelineItems([mediaPrompt, mediaCard], {
      chat: [live('u1', 'user', 'describe it'), live('a1', 'assistant', 'a cas')],
    })

    expect(kinds(items)).toEqual(['media', 'chat'])
    const chat = items[1]
    expect(chat.kind === 'chat' && chat.messages.map((message) => message.id)).toEqual(['u1', 'a1'])
  })

  it('shows the live copy of a saved chat message in place, once', () => {
    const items = sessionTimelineItems(
      [
        chatMessage('u1', 'user', 'hi'),
        chatMessage('a1', 'assistant', 'hel'),
        mediaPrompt,
        mediaCard,
      ],
      { chat: [live('u1', 'user', 'hi'), live('a1', 'assistant', 'hello there')] },
    )

    expect(kinds(items)).toEqual(['chat', 'media'])
    const chat = items[0]
    expect(chat.kind === 'chat' && chat.messages.map((message) => message.parts)).toEqual([
      [{ type: 'text', text: 'hi' }],
      [{ type: 'text', text: 'hello there' }],
    ])
  })

  it('drops the in-flight media run once its result card is in the timeline', () => {
    const items = sessionTimelineItems([mediaPrompt, mediaCard], {
      media: { ...pendingMedia, runId: 'r1' },
    })

    expect(kinds(items)).toEqual(['media'])
  })

  it('shows the running agent turn and marks its block as the live one', () => {
    const running = { tag: agentTurn, messages: [live('u9', 'user', 'go')], live: true }
    const items = sessionTimelineItems([mediaPrompt, mediaCard], { agents: [running] })

    expect(kinds(items)).toEqual(['media', 'agent'])
    expect(items[1]).toMatchObject({ kind: 'agent', live: running })
  })

  it("streams a Task Run's Step beside the Agent's own Harness Session", () => {
    const taskRun = { taskName: 'Morning digest', startedAt: 500 }
    const items = sessionTimelineItems([agentMessage('u1', 'user', 'hello')], {
      agents: [
        { tag: agentTurn, messages: [live('u1', 'user', 'hello')], live: false },
        {
          tag: { presetName: 'Agent', harnessSessionId: 'aipg-agent-run', taskRun },
          messages: [live('s1', 'user', 'step one')],
          live: true,
        },
      ],
    })

    expect(kinds(items)).toEqual(['agent', 'agent'])
    expect(items[1]).toMatchObject({ kind: 'agent', taskRun })
  })

  it('ends with the audio turn still running', () => {
    const items = sessionTimelineItems([mediaPrompt, mediaCard], { audio: pendingAudio })

    expect(kinds(items)).toEqual(['media', 'pending-audio'])
  })
})
