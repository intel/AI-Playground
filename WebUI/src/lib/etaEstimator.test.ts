import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EtaEstimator } from './etaEstimator'

// The download service reports once per second, with the percent rounded to two decimals.
const reportedPercent = (done: number, total: number) => Math.round((done / total) * 10000) / 100
const at = (seconds: number) => vi.setSystemTime(1_000_000 + seconds * 1000)

describe('EtaEstimator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows an ETA when a report repeats the previous percent', () => {
    const eta = new EtaEstimator(100)
    const total = 20 * 1024 ** 3
    const speed = 1.5 * 1024 ** 2
    let last = '--'
    for (let t = 0; t <= 60; t++) {
      at(t)
      last = eta.updateAndEstimate(reportedPercent(t * speed, total))
    }
    expect(last).toMatch(/^3h \d+m \d+s$/)
  })

  it('keeps the ETA through a one-second stall', () => {
    const eta = new EtaEstimator(100)
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8]
    values.forEach((v, t) => {
      at(t)
      eta.updateAndEstimate(v)
    })
    at(9)
    expect(eta.updateAndEstimate(8)).toBe('1m 32s')
    at(10)
    expect(eta.updateAndEstimate(9)).toBe('1m 36s')
  })

  it('starts over when the percent goes back down', () => {
    const eta = new EtaEstimator(100)
    for (let t = 0; t <= 10; t++) {
      at(t)
      eta.updateAndEstimate(t * 5)
    }
    at(11)
    expect(eta.updateAndEstimate(0)).toBe('--')
  })
})
