import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { KernelEvent } from '@/types/kernelEvents'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => './tmp' },
}))

const {
  setKernelEventWindow,
  emitServiceUpdate,
  beginAgentTurnSnapshot,
  emitAgentChunk,
  emitAgentToolProgress,
  emitAgentToolImage,
  emitAgentTurnDone,
  getKernelSnapshot,
  resetKernelBusForTest,
  beginChatTurnSnapshot,
  emitChatChunk,
  emitChatRag,
  endChatTurn,
  getChatTurnChunks,
  emitMediaAgentEvent,
  endMediaAgentRun,
  emitActivity,
  emitFailure,
  emitStored,
  setInferenceProfileSnapshot,
} = await import('../../kernel/kernelBus')

function fakeWindow(): { win: BrowserWindow; sent: KernelEvent[] } {
  const sent: KernelEvent[] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_channel: string, event: KernelEvent) => void sent.push(event) },
  } as unknown as BrowserWindow
  return { win, sent }
}

beforeEach(() => {
  resetKernelBusForTest()
})

describe('kernel bus', () => {
  it('stamps every event with one strictly monotonic sequence', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    emitServiceUpdate({ serviceName: 'ai-backend', status: 'notYetStarted' })
    beginAgentTurnSnapshot('turn-1')
    emitAgentChunk('turn-1', { type: 'text-start' })
    emitAgentToolProgress('turn-1', 'call-1', 'browser', 'navigating')
    emitAgentToolImage('call-1', 'data:image/png;base64,', 'cover.png')
    emitAgentTurnDone('turn-1')
    const seqs = sent.map((event) => event.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5])
  })

  it('emits nothing and throws nothing without a live window', () => {
    emitServiceUpdate({ serviceName: 'ai-backend', status: 'notYetStarted' })
    expect(getKernelSnapshot().sequence).toBe(1)
  })

  it('survives a destroyed window', () => {
    setKernelEventWindow({ isDestroyed: () => true } as unknown as BrowserWindow)
    expect(() => emitServiceUpdate({ serviceName: 'ai-backend' })).not.toThrow()
  })

  it('records service info for the snapshot, keyed by serviceName', () => {
    emitServiceUpdate({ serviceName: 'ai-backend', status: 'notYetStarted' })
    emitServiceUpdate({ serviceName: 'ai-backend', status: 'running' })
    emitServiceUpdate({ serviceName: 'llamacpp-backend', status: 'running' })
    const snapshot = getKernelSnapshot()
    expect(snapshot.sequence).toBe(3)
    expect(snapshot.state.services).toEqual([
      { serviceName: 'ai-backend', status: 'running' },
      { serviceName: 'llamacpp-backend', status: 'running' },
    ])
  })

  it('ignores service payloads without a serviceName', () => {
    emitServiceUpdate({ status: 'running' })
    expect(getKernelSnapshot().state.services).toEqual([])
  })

  it('merges adjacent text deltas of the same part in the turn snapshot', () => {
    beginAgentTurnSnapshot('turn-1')
    emitAgentChunk('turn-1', { type: 'text-start', id: 'a' })
    emitAgentChunk('turn-1', { type: 'text-delta', id: 'a', delta: 'Hel' })
    emitAgentChunk('turn-1', { type: 'text-delta', id: 'a', delta: 'lo' })
    emitAgentChunk('turn-1', { type: 'reasoning-delta', id: 'r', delta: 'hmm' })
    emitAgentChunk('turn-1', { type: 'reasoning-delta', id: 'r', delta: '…' })
    expect(getKernelSnapshot().state.activeTurn?.chunks).toEqual([
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: 'Hello' },
      { type: 'reasoning-delta', id: 'r', delta: 'hmm…' },
    ])
  })

  it('does not merge agent snapshot deltas across parts or types', () => {
    beginAgentTurnSnapshot('turn-1')
    emitAgentChunk('turn-1', { type: 'text-delta', id: 'a', delta: 'a' })
    emitAgentChunk('turn-1', { type: 'text-delta', id: 'b', delta: 'b' })
    emitAgentChunk('turn-1', { type: 'reasoning-delta', id: 'a', delta: 'c' })
    expect(getKernelSnapshot().state.activeTurn?.chunks).toEqual([
      { type: 'text-delta', id: 'a', delta: 'a' },
      { type: 'text-delta', id: 'b', delta: 'b' },
      { type: 'reasoning-delta', id: 'a', delta: 'c' },
    ])
  })

  it('accumulates the active turn and clears it when the turn is done', () => {
    beginAgentTurnSnapshot('turn-1')
    emitAgentChunk('turn-1', { type: 'text-start' })
    emitAgentChunk('turn-1', { type: 'text-delta', id: 'a', delta: 'hello' })
    emitAgentToolProgress('turn-1', 'call-1', 'browser', 'navigating')
    emitAgentToolImage('call-1', 'data:image/png;base64,', 'cover.png')

    expect(getKernelSnapshot().state.activeTurn).toEqual({
      turnId: 'turn-1',
      chunks: [{ type: 'text-start' }, { type: 'text-delta', id: 'a', delta: 'hello' }],
      toolProgress: { 'call-1': 'navigating' },
      toolImages: {
        'call-1': [
          {
            type: 'agent-tool-image',
            toolCallId: 'call-1',
            dataUri: 'data:image/png;base64,',
            label: 'cover.png',
          },
        ],
      },
    })

    emitAgentTurnDone('turn-1')
    expect(getKernelSnapshot().state.activeTurn).toBeNull()
  })

  it('clears the accumulator synchronously with the done event, so the watermark stays sound', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    beginAgentTurnSnapshot('turn-1')
    emitAgentTurnDone('turn-1')
    // The done event is on the stream; a snapshot at this seq must not still
    // name the turn, or a reconnect would adopt a dead one.
    expect(sent.at(-1)?.type).toBe('agent-turn-done')
    expect(getKernelSnapshot().state.activeTurn).toBeNull()
  })

  it('ignores chunks and progress that belong to no active turn', () => {
    emitAgentChunk('turn-9', { type: 'text-start' })
    emitAgentToolProgress('turn-9', 'call-1', 'browser', 'x')
    emitAgentToolImage('call-9', 'data:image/png;base64,', 'orphan.png')
    const snapshot = getKernelSnapshot()
    expect(snapshot.state.activeTurn).toBeNull()
    expect(snapshot.sequence).toBe(3)
  })

  it('sends to the window set by setKernelEventWindow, not an older one', () => {
    const first = fakeWindow()
    const second = fakeWindow()
    setKernelEventWindow(first.win)
    setKernelEventWindow(second.win)
    emitServiceUpdate({ serviceName: 'ai-backend' })
    expect(first.sent).toHaveLength(0)
    expect(second.sent).toHaveLength(1)
  })
})

describe('kernel bus chat chunks', () => {
  type ChatEvent = Extract<KernelEvent, { type: 'chat-chunk' }>

  function chatEvents(sent: KernelEvent[]): ChatEvent[] {
    return sent.filter((event): event is ChatEvent => event.type === 'chat-chunk')
  }

  it('coalesces adjacent text deltas of the same part until the flush window', () => {
    vi.useFakeTimers()
    try {
      const { win, sent } = fakeWindow()
      setKernelEventWindow(win)
      beginChatTurnSnapshot('conv-1', 'turn-1')
      emitChatChunk('conv-1', 'turn-1', { type: 'start' })
      emitChatChunk('conv-1', 'turn-1', { type: 'text-start', id: 'text-0' })
      emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'text-0', delta: 'Hel' })
      emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'text-0', delta: 'lo' })
      // Only the semantic start chunks are out; both deltas are still pending.
      expect(chatEvents(sent).map((e) => e.chunk.type)).toEqual(['start', 'text-start'])
      vi.advanceTimersByTime(31)
      expect(chatEvents(sent)).toHaveLength(2)
      vi.advanceTimersByTime(1)
      const events = chatEvents(sent)
      expect(events).toHaveLength(3)
      expect(events.at(-1)!.chunk).toEqual({ type: 'text-delta', id: 'text-0', delta: 'Hello' })
      expect(events.at(-1)!.conversationKey).toBe('conv-1')
      expect(events[0].turnId).toBe('turn-1')
      expect(events[0].scope).toEqual({ kind: 'chat', conversationKey: 'conv-1' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes pending deltas before a semantic chunk, preserving order', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    beginChatTurnSnapshot('conv-1', 'turn-1')
    emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'text-0', delta: 'Hi' })
    emitChatChunk('conv-1', 'turn-1', {
      type: 'tool-input-available',
      toolCallId: 'call-1',
      toolName: 'comfyUI',
      input: {},
    })
    const events = chatEvents(sent)
    expect(events.map((e) => e.chunk.type)).toEqual(['text-delta', 'tool-input-available'])
    expect(events[0].chunk).toEqual({ type: 'text-delta', id: 'text-0', delta: 'Hi' })
  })

  it('does not merge across parts: a new id flushes the previous delta', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    beginChatTurnSnapshot('conv-1', 'turn-1')
    emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'text-0', delta: 'a' })
    emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'text-1', delta: 'b' })
    // The new part's delta flushes the old one; the new one stays pending.
    expect(chatEvents(sent).map((e) => e.chunk)).toEqual([
      { type: 'text-delta', id: 'text-0', delta: 'a' },
    ])
    endChatTurn('conv-1', 'turn-1')
    expect(chatEvents(sent).map((e) => e.chunk)).toEqual([
      { type: 'text-delta', id: 'text-0', delta: 'a' },
      { type: 'text-delta', id: 'text-1', delta: 'b' },
    ])
  })

  it('does not merge reasoning into text of the same id', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    beginChatTurnSnapshot('conv-1', 'turn-1')
    emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'part-0', delta: 'a' })
    emitChatChunk('conv-1', 'turn-1', { type: 'reasoning-delta', id: 'part-0', delta: 'b' })
    // The reasoning delta flushes the text one; reasoning itself stays pending.
    expect(chatEvents(sent).map((e) => e.chunk.type)).toEqual(['text-delta'])
    endChatTurn('conv-1', 'turn-1')
    expect(chatEvents(sent).map((e) => e.chunk.type)).toEqual(['text-delta', 'reasoning-delta'])
  })

  it('merges reasoning timing metadata: first start, latest finish', () => {
    vi.useFakeTimers()
    try {
      const { win, sent } = fakeWindow()
      setKernelEventWindow(win)
      beginChatTurnSnapshot('conv-1', 'turn-1')
      emitChatChunk('conv-1', 'turn-1', {
        type: 'reasoning-delta',
        id: 'reasoning-0',
        delta: 'th',
        providerMetadata: { aipg: { reasoningStarted: 100, reasoningFinished: 110 } },
      })
      emitChatChunk('conv-1', 'turn-1', {
        type: 'reasoning-delta',
        id: 'reasoning-0',
        delta: 'inking',
        providerMetadata: { aipg: { reasoningStarted: 999, reasoningFinished: 120 } },
      })
      vi.advanceTimersByTime(32)
      const events = chatEvents(sent)
      expect(events).toHaveLength(1)
      expect(events[0].chunk).toEqual({
        type: 'reasoning-delta',
        id: 'reasoning-0',
        delta: 'thinking',
        providerMetadata: { aipg: { reasoningStarted: 100, reasoningFinished: 120 } },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('endChatTurn flushes pending deltas and clears the snapshot', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    beginChatTurnSnapshot('conv-1', 'turn-1')
    emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'text-0', delta: 'tail' })
    endChatTurn('conv-1', 'turn-1')
    const events = chatEvents(sent)
    expect(events.at(-1)?.chunk).toEqual({ type: 'text-delta', id: 'text-0', delta: 'tail' })
    expect(sent.at(-1)?.type).toBe('chat-turn-done')
    expect(getKernelSnapshot().state.chatTurns).toEqual([])
  })

  it('getChatTurnChunks returns the coalesced log with the current sequence', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    beginChatTurnSnapshot('conv-1', 'turn-1')
    emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'text-0', delta: 'x' })
    emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'text-0', delta: 'y' })
    const captured = getChatTurnChunks('conv-1', 'turn-1')
    expect(captured).not.toBeNull()
    expect(captured!.chunks).toEqual([{ type: 'text-delta', id: 'text-0', delta: 'xy' }])
    expect(captured!.sequence).toBe(1)
    expect(chatEvents(sent)).toHaveLength(1)
    expect(getKernelSnapshot().state.chatTurns[0]?.chunks).toEqual(captured!.chunks)
  })

  it('getKernelSnapshot watermarks sequence after flushing pending chat deltas', () => {
    vi.useFakeTimers()
    try {
      const { win, sent } = fakeWindow()
      setKernelEventWindow(win)
      beginChatTurnSnapshot('conv-1', 'turn-1')
      emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'text-0', delta: 'x' })
      expect(chatEvents(sent)).toHaveLength(0)
      const snapshot = getKernelSnapshot()
      expect(snapshot.state.chatTurns[0]?.chunks).toEqual([
        { type: 'text-delta', id: 'text-0', delta: 'x' },
      ])
      expect(snapshot.sequence).toBe(1)
      expect(chatEvents(sent)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tracks concurrent turns per conversation independently', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    beginChatTurnSnapshot('conv-1', 'turn-1')
    beginChatTurnSnapshot('conv-2', 'turn-2')
    emitChatChunk('conv-1', 'turn-1', { type: 'text-delta', id: 'text-0', delta: 'a' })
    emitChatChunk('conv-2', 'turn-2', { type: 'text-delta', id: 'text-0', delta: 'b' })
    endChatTurn('conv-1', 'turn-1')
    endChatTurn('conv-2', 'turn-2')
    const events = chatEvents(sent)
    expect(events.map((e) => e.conversationKey)).toEqual(['conv-1', 'conv-2'])
    expect(getKernelSnapshot().state.chatTurns).toEqual([])
  })

  it('emits chat-rag without recording it on the turn snapshot', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    beginChatTurnSnapshot('conv-1', 'turn-1')
    emitChatRag('conv-1', 'turn-1', 'warranty.pdf (Lines 3-5)')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'chat-rag',
      conversationKey: 'conv-1',
      turnId: 'turn-1',
      sourceText: 'warranty.pdf (Lines 3-5)',
    })
    expect(getKernelSnapshot().state.chatTurns[0]?.chunks).toEqual([])
  })
})

describe('kernel bus media agent events', () => {
  it('coalesces adjacent narration deltas of one run until the flush window', async () => {
    vi.useFakeTimers()
    try {
      const { win, sent } = fakeWindow()
      setKernelEventWindow(win)
      emitMediaAgentEvent('run-1', { type: 'narration-delta', kind: 'text', text: 'Think' })
      emitMediaAgentEvent('run-1', { type: 'narration-delta', kind: 'text', text: 'ing' })
      emitMediaAgentEvent('run-1', { type: 'narration-delta', kind: 'text', text: '…' })
      expect(sent).toHaveLength(0)
      vi.advanceTimersByTime(40)
      expect(sent).toHaveLength(1)
      const event = sent[0] as Extract<KernelEvent, { type: 'media-agent-event' }>
      expect(event.runKey).toBe('run-1')
      expect(event.event).toEqual({ type: 'narration-delta', kind: 'text', text: 'Thinking…' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes pending narration before a semantic event of the same run, preserving order', async () => {
    vi.useFakeTimers()
    try {
      const { win, sent } = fakeWindow()
      setKernelEventWindow(win)
      emitMediaAgentEvent('run-1', { type: 'narration-delta', kind: 'reasoning', text: 'plan' })
      emitMediaAgentEvent('run-1', {
        type: 'tool-start',
        toolCallId: 'c1',
        toolName: 'comfyUI',
        input: {},
      })
      expect(sent).toHaveLength(2)
      expect(sent[0]).toMatchObject({
        type: 'media-agent-event',
        event: { type: 'narration-delta', kind: 'reasoning', text: 'plan' },
      })
      expect(sent[1]).toMatchObject({ type: 'media-agent-event', event: { type: 'tool-start' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not merge narration across runs or kinds', async () => {
    vi.useFakeTimers()
    try {
      const { win, sent } = fakeWindow()
      setKernelEventWindow(win)
      emitMediaAgentEvent('run-1', { type: 'narration-delta', kind: 'text', text: 'a' })
      emitMediaAgentEvent('run-1', { type: 'narration-delta', kind: 'reasoning', text: 'b' })
      emitMediaAgentEvent('run-2', { type: 'narration-delta', kind: 'text', text: 'c' })
      vi.advanceTimersByTime(40)
      expect(sent).toHaveLength(3)
      const texts = sent.map((e) => (e as { event: { text?: string } }).event.text)
      expect(texts).toEqual(['a', 'b', 'c'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('endMediaAgentRun flushes pending narration and stops tracking the run', async () => {
    vi.useFakeTimers()
    try {
      const { win, sent } = fakeWindow()
      setKernelEventWindow(win)
      emitMediaAgentEvent('run-1', { type: 'narration-delta', kind: 'text', text: 'final' })
      endMediaAgentRun('run-1')
      expect(sent).toHaveLength(1)
      // Post-run narration (should not happen) starts a fresh accumulator.
      emitMediaAgentEvent('run-1', { type: 'narration-delta', kind: 'text', text: 'late' })
      vi.advanceTimersByTime(40)
      expect(sent).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('kernel bus ledger events', () => {
  it('keeps in-flight activities on the snapshot and drops them when they end', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    emitActivity('begin', {
      id: 'backend-load-1',
      category: 'backend',
      label: 'Loading Qwen…',
      scope: { kind: 'global' },
      state: 'active',
    })
    expect(getKernelSnapshot().state.activities).toEqual([
      expect.objectContaining({ id: 'backend-load-1', state: 'active' }),
    ])
    emitActivity('end', {
      id: 'backend-load-1',
      category: 'backend',
      label: 'Loading Qwen…',
      scope: { kind: 'global' },
      state: 'done',
    })
    expect(getKernelSnapshot().state.activities).toEqual([])
    expect(sent.map((event) => event.type)).toEqual(['activity', 'activity'])
    expect((sent[1] as { action: string }).action).toBe('end')
  })

  it('stamps a failure onto the bus as an error event with surface', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    emitFailure({
      category: 'backend',
      code: 'backend/not-ready',
      userMessage: 'Could not load Qwen.',
      surface: 'silent',
    })
    expect(sent[0]).toMatchObject({
      type: 'error',
      error: {
        code: 'backend/not-ready',
        userMessage: 'Could not load Qwen.',
        surface: 'silent',
      },
    })
  })

  it('publishes the live inference profile as stored + snapshot memory', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    setInferenceProfileSnapshot({
      serviceName: 'llamacpp-backend',
      llmModelName: 'Qwen3-9B',
      active: true,
    })
    expect(getKernelSnapshot().state.inferenceProfile).toEqual({
      serviceName: 'llamacpp-backend',
      llmModelName: 'Qwen3-9B',
      active: true,
    })
    expect(sent[0]).toMatchObject({
      type: 'stored',
      kind: 'inference-profile',
      inferenceProfile: { llmModelName: 'Qwen3-9B', active: true },
    })
    emitStored('conversation', 'conv-1')
    expect(sent[1]).toMatchObject({ type: 'stored', kind: 'conversation', id: 'conv-1' })
  })
})
