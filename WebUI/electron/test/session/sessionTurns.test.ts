import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { claimSessionTurn, releaseSessionTurn, resetSessionTurnsForTest } =
  await import('../../session/sessionTurns')
const { getKernelSnapshot, resetKernelBusForTest } = await import('../../kernel/kernelBus')

afterEach(() => {
  resetSessionTurnsForTest()
  resetKernelBusForTest()
})

describe('Session turn ledger', () => {
  it('admits one turn per Session and refuses a second while it is in flight', () => {
    expect(claimSessionTurn('session-a', { turnId: 't1', kind: 'agent' })).toBe(true)
    expect(claimSessionTurn('session-a', { turnId: 't2', kind: 'media' })).toBe(false)
  })

  it('leaves other Sessions unaffected', () => {
    expect(claimSessionTurn('session-a', { turnId: 't1', kind: 'agent' })).toBe(true)
    expect(claimSessionTurn('session-b', { turnId: 't2', kind: 'chat' })).toBe(true)
  })

  it('admits the next turn once the first is released', () => {
    claimSessionTurn('session-a', { turnId: 't1', kind: 'media' })
    releaseSessionTurn('session-a', 't1')
    expect(claimSessionTurn('session-a', { turnId: 't2', kind: 'media' })).toBe(true)
  })

  it('ignores a release for a turn that does not hold the Session', () => {
    claimSessionTurn('session-a', { turnId: 't1', kind: 'media' })
    releaseSessionTurn('session-a', 'other')
    expect(claimSessionTurn('session-a', { turnId: 't2', kind: 'media' })).toBe(false)
  })

  it('shows which Sessions are busy in the kernel snapshot', () => {
    claimSessionTurn('session-a', {
      turnId: 't1',
      kind: 'agent',
      presetName: 'Agent',
      harnessSessionId: 'aipg-agent-1',
    })
    claimSessionTurn('session-b', { turnId: 't2', kind: 'media', presetName: 'Flux' })
    releaseSessionTurn('session-b', 't2')
    expect(getKernelSnapshot().state.sessionTurns).toEqual({
      'session-a': {
        turnId: 't1',
        kind: 'agent',
        presetName: 'Agent',
        harnessSessionId: 'aipg-agent-1',
      },
    })
  })
})
