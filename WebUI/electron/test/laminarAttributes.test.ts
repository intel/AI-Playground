import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
    getAppPath: () => '/tmp',
  },
}))

const {
  stampSpanStart,
  stampSpanEnd,
  setChatTraceContext,
  setAgentRunIdentity,
  clearAgentRunIdentity,
  recordAgentCallStats,
  recordChatCallStats,
} = await import('../laminarAttributes.ts')

const METADATA = 'lmnr.association.properties.metadata.'
const HOST = `${METADATA}hostname`
const DEVICE = `${METADATA}device`
const DEVICE_NAME = `${METADATA}deviceName`
const PRESET = `${METADATA}preset`
const AGENT_TYPE = `${METADATA}agentType`
const CAPABILITIES = `${METADATA}capabilities`
const GAME = `${METADATA}game`
const GAME_ID = `${METADATA}gameId`
const GEN_TPS = `${METADATA}genTps`
const PREFILL_TPS = `${METADATA}prefillTps`
const LLM_CALLS = `${METADATA}llmCalls`
const SPAN_TYPE = 'lmnr.span.type'

describe('stampSpanStart', () => {
  afterEach(() => setChatTraceContext(null))

  it('stamps hostname even without a turn context', () => {
    const span = { attributes: {} as Record<string, unknown> }
    stampSpanStart(span)
    expect(span.attributes[HOST]).toBe(os.hostname())
  })

  it('stamps device id and name from the chat context', () => {
    setChatTraceContext({
      backend: 'llamaCPP',
      device: 'GPU.0',
      deviceName: 'Intel Arc B580',
    })
    const span = { name: 'ai.streamText', attributes: {} as Record<string, unknown> }
    stampSpanStart(span)
    expect(span.attributes[HOST]).toBe(os.hostname())
    expect(span.attributes[DEVICE]).toBe('GPU.0')
    expect(span.attributes[DEVICE_NAME]).toBe('Intel Arc B580')
  })

  it('stamps the chat preset', () => {
    setChatTraceContext({ backend: 'llamaCPP', preset: 'Agentic Chat' })
    const span = { name: 'ai.streamText', attributes: {} as Record<string, unknown> }
    stampSpanStart(span)
    expect(span.attributes[PRESET]).toBe('Agentic Chat')
  })
})

describe('agent run labels', () => {
  afterEach(() => clearAgentRunIdentity())

  const rootSpan = () => ({ name: 'pi agent run', attributes: {} as Record<string, unknown> })

  it('names the run after its preset and game, and stamps what it is', () => {
    setAgentRunIdentity(() => ({
      preset: 'Game Agent',
      type: 'game-agent',
      capabilities: 'game-studio, media, web-debug',
      appSession: 'aipg-agent-7',
      game: 'Asteroid Rush',
      gameId: 'asteroid-rush',
    }))
    const span = rootSpan()
    stampSpanStart(span)
    expect(span.name).toBe('Game Agent · Asteroid Rush')
    expect(span.attributes[PRESET]).toBe('Game Agent')
    expect(span.attributes[AGENT_TYPE]).toBe('game-agent')
    expect(span.attributes[CAPABILITIES]).toBe('game-studio, media, web-debug')
    expect(span.attributes[`${METADATA}appSession`]).toBe('aipg-agent-7')
    expect(span.attributes[GAME]).toBe('Asteroid Rush')
    expect(span.attributes[GAME_ID]).toBe('asteroid-rush')
  })

  it('falls back to the preset alone', () => {
    setAgentRunIdentity(() => ({ preset: 'Quick Coder', type: 'quick-coder' }))
    const span = rootSpan()
    stampSpanStart(span)
    expect(span.name).toBe('Quick Coder')
  })

  it('leaves the name alone when there is nothing to say', () => {
    setAgentRunIdentity(() => ({ type: 'agent' }))
    const span = rootSpan()
    stampSpanStart(span)
    expect(span.name).toBe('pi agent run')
    expect(span.attributes[AGENT_TYPE]).toBe('agent')
  })

  it('renames only the span Pi named', () => {
    setAgentRunIdentity(() => ({ preset: 'Game Agent', game: 'Asteroid Rush' }))
    const span = { name: 'LLM call (turn 2)', attributes: {} as Record<string, unknown> }
    stampSpanStart(span)
    expect(span.name).toBe('LLM call (turn 2)')
    expect(span.attributes[GAME]).toBe('Asteroid Rush')
  })

  it('leaves spans that have a parent to the trace they hang off', () => {
    setAgentRunIdentity(() => ({ preset: 'Game Agent' }))
    const span = {
      name: 'pi agent run',
      parentSpanId: 'abc',
      attributes: {} as Record<string, unknown>,
    }
    stampSpanStart(span)
    expect(span.name).toBe('pi agent run')
    expect(span.attributes[PRESET]).toBeUndefined()
  })

  it('re-reads the identity per span, so a game named mid-run shows up', () => {
    const named: { game?: string } = {}
    setAgentRunIdentity(() => ({ preset: 'Game Agent', game: named.game }))
    const first = rootSpan()
    stampSpanStart(first)
    named.game = 'Asteroid Rush'
    const second = rootSpan()
    stampSpanStart(second)
    expect(first.name).toBe('Game Agent')
    expect(second.name).toBe('Game Agent · Asteroid Rush')
  })

  it('prefers updateName on a live span', () => {
    setAgentRunIdentity(() => ({ preset: 'Game Agent' }))
    const names: string[] = []
    const span = {
      name: 'pi agent run',
      attributes: {} as Record<string, unknown>,
      isRecording: () => true,
      setAttribute: (key: string, value: string | number | boolean) => {
        span.attributes[key] = value
      },
      updateName: (name: string) => names.push(name),
    }
    stampSpanStart(span)
    expect(names).toEqual(['Game Agent'])
    expect(span.attributes[PRESET]).toBe('Game Agent')
  })
})

// A trace's speeds: the per-call numbers summed into one, on the span that
// outlives the calls. Weighted by the time each call took, so a short reply
// cannot pull the figure around.
describe('run speeds', () => {
  type Span = {
    name: string
    attributes: Record<string, unknown>
    spanContext: () => { traceId: string; spanId: string }
  }

  const span = (name: string, traceId: string, spanId: string): Span => ({
    name,
    attributes:
      name.startsWith('ai.llm') || name.startsWith('LLM call') ? { [SPAN_TYPE]: 'LLM' } : {},
    spanContext: () => ({ traceId, spanId }),
  })

  function agentCall(traceId: string, spanId: string, stats: Record<string, number>): void {
    const llm = span(`LLM call (turn ${spanId})`, traceId, spanId)
    stampSpanStart(llm)
    recordAgentCallStats(stats)
    stampSpanEnd(llm)
  }

  it('weights each call by how long it generated for', () => {
    const root = span('pi agent run', 't1', 'root')
    stampSpanStart(root)
    agentCall('t1', '1', {
      generationTokensPerSecond: 10,
      predictedMs: 1000,
      prefillTokensPerSecond: 100,
      promptMs: 500,
    })
    agentCall('t1', '2', {
      generationTokensPerSecond: 20,
      predictedMs: 3000,
      prefillTokensPerSecond: 300,
      promptMs: 1500,
    })
    stampSpanEnd(root)
    // 10 + 60 tokens over 4 s, not the arithmetic mean of 10 and 20.
    expect(root.attributes[GEN_TPS]).toBe(17.5)
    expect(root.attributes[PREFILL_TPS]).toBe(250)
    expect(root.attributes[LLM_CALLS]).toBe(2)
  })

  it('counts a delegated media call towards the run it served', () => {
    const root = span('pi agent run', 't2', 'root')
    stampSpanStart(root)
    agentCall('t2', '1', { generationTokensPerSecond: 10, predictedMs: 1000 })
    const delegated = span('ai.llm model.chat:test', 't2', 'media')
    stampSpanStart(delegated)
    recordChatCallStats({ generationTokensPerSecond: 30, predictedMs: 1000 })
    stampSpanEnd(delegated)
    stampSpanEnd(root)
    expect(root.attributes[GEN_TPS]).toBe(20)
    expect(root.attributes[LLM_CALLS]).toBe(2)
  })

  it('keeps traces apart', () => {
    const first = span('pi agent run', 't3', 'root-3')
    const second = span('pi agent run', 't4', 'root-4')
    stampSpanStart(first)
    stampSpanStart(second)
    agentCall('t3', '1', { generationTokensPerSecond: 10, predictedMs: 1000 })
    agentCall('t4', '2', { generationTokensPerSecond: 40, predictedMs: 1000 })
    stampSpanEnd(first)
    stampSpanEnd(second)
    expect(first.attributes[GEN_TPS]).toBe(10)
    expect(second.attributes[GEN_TPS]).toBe(40)
  })

  it('says nothing about a run that called no model', () => {
    const root = span('pi agent run', 't5', 'root')
    stampSpanStart(root)
    stampSpanEnd(root)
    expect(root.attributes[GEN_TPS]).toBeUndefined()
    expect(root.attributes[LLM_CALLS]).toBeUndefined()
  })

  it('reports a chat turn on its own root, not on the call', () => {
    const root = span('ai.streamText', 't6', 'root')
    stampSpanStart(root)
    const call = span('ai.llm model.chat:test', 't6', 'call')
    stampSpanStart(call)
    recordChatCallStats({ generationTokensPerSecond: 12.5, predictedMs: 2000 })
    stampSpanEnd(call)
    stampSpanEnd(root)
    expect(call.attributes[GEN_TPS]).toBeUndefined()
    expect(root.attributes[GEN_TPS]).toBe(12.5)
  })

  it('leaves the totals off a run whose calls were never timed', () => {
    const root = span('pi agent run', 't7', 'root')
    stampSpanStart(root)
    agentCall('t7', '1', {})
    stampSpanEnd(root)
    expect(root.attributes[LLM_CALLS]).toBe(1)
    expect(root.attributes[GEN_TPS]).toBeUndefined()
  })
})
