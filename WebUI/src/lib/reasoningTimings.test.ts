import { describe, expect, it } from 'vitest'
import { reasoningElapsedMsFromParts, reasoningTimingOf } from './reasoningTimings'

function reasoning(startedAt?: number, finishedAt?: number) {
  return {
    type: 'reasoning',
    providerMetadata: {
      aipg: {
        ...(startedAt === undefined ? {} : { reasoningStarted: startedAt }),
        ...(finishedAt === undefined ? {} : { reasoningFinished: finishedAt }),
      },
    },
  }
}

describe('reasoningTimingOf', () => {
  it('reads the stamps a producer put on the part', () => {
    expect(reasoningTimingOf(reasoning(1_000, 4_200))).toEqual({
      startedAt: 1_000,
      finishedAt: 4_200,
    })
  })

  it('reports a block that is still streaming as started but unfinished', () => {
    expect(reasoningTimingOf(reasoning(1_000))).toEqual({
      startedAt: 1_000,
      finishedAt: undefined,
    })
  })

  it('invents nothing for a transcript recorded before timings existed', () => {
    expect(reasoningTimingOf({ type: 'reasoning' })).toEqual({
      startedAt: undefined,
      finishedAt: undefined,
    })
  })
})

describe('reasoningElapsedMsFromParts', () => {
  it('sums per-block durations so tool execution is not counted as thinking', () => {
    const parts = [
      reasoning(1_000, 2_000),
      // A tool ran for a minute between the two blocks.
      { type: 'dynamic-tool', toolName: 'bash', state: 'output-available' },
      reasoning(62_000, 62_500),
    ]

    expect(reasoningElapsedMsFromParts(parts)).toBe(1_500)
  })

  it('skips blocks that never finished, and non-reasoning parts', () => {
    expect(reasoningElapsedMsFromParts([reasoning(1_000), { type: 'text' }])).toBe(0)
  })
})
