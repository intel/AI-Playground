import { describe, expect, it } from 'vitest'
import {
  bothFit,
  emptyCardBudgetBytes,
  fitVram,
  liveBudgetBytes,
  vramFitBars,
  vramFitLevel,
  VRAM_EASY_FRACTION,
  VRAM_USABLE_FRACTION,
} from './fit.ts'
import { GIB } from './units.ts'

const CARD = 16 * GIB

describe('fitVram', () => {
  it('treats 90% of the card as the empty-card budget', () => {
    expect(emptyCardBudgetBytes(CARD)).toBe(CARD * VRAM_USABLE_FRACTION)
    const fit = fitVram(15 * GIB, { memTotalBytes: CARD })
    expect(fit.fitsEmptyCard).toBe(false)
    expect(fitVram(14 * GIB, { memTotalBytes: CARD }).fitsEmptyCard).toBe(true)
  })

  it('adds back a resident estimate so a loaded LLM is not double-counted', () => {
    const required = 8 * GIB
    const without = liveBudgetBytes({
      memTotalBytes: CARD,
      memUsedBytes: 10 * GIB,
    })
    const withResident = liveBudgetBytes({
      memTotalBytes: CARD,
      memUsedBytes: 10 * GIB,
      residentEstimateBytes: 8 * GIB,
    })
    expect(without).toBe(6 * GIB)
    expect(withResident).toBe(14 * GIB)
    expect(fitVram(required, { memTotalBytes: CARD, memUsedBytes: 10 * GIB }).fitsLive).toBe(false)
    expect(
      fitVram(required, {
        memTotalBytes: CARD,
        memUsedBytes: 10 * GIB,
        residentEstimateBytes: 8 * GIB,
      }).fitsLive,
    ).toBe(true)
  })

  it('caps live budget by the empty-card fraction', () => {
    expect(
      liveBudgetBytes({
        memTotalBytes: CARD,
        memUsedBytes: 0,
      }),
    ).toBe(emptyCardBudgetBytes(CARD))
  })

  it('checks host RAM when the GPU is sharing it', () => {
    const fit = fitVram(8 * GIB, { memTotalBytes: CARD, hostFreeBytes: 10 * GIB })
    expect(fit.fitsHost).toBe(false)
    expect(fitVram(4 * GIB, { memTotalBytes: CARD, hostFreeBytes: 10 * GIB }).fitsHost).toBe(true)
  })

  it('decides whether an LLM and a ComfyUI run can stay co-resident', () => {
    const llm = 8 * GIB
    const comfy = 7 * GIB
    const tight: Parameters<typeof bothFit>[2] = {
      memTotalBytes: CARD,
      memUsedBytes: 1 * GIB,
    }
    expect(bothFit(llm, comfy, tight)).toBe(false)
    expect(bothFit(llm, 4 * GIB, { memTotalBytes: CARD, memUsedBytes: 0 })).toBe(true)
  })
})

describe('vramFitLevel', () => {
  const usable = emptyCardBudgetBytes(CARD)
  const easy = usable * VRAM_EASY_FRACTION

  it('reports the boundaries as inclusive', () => {
    expect(vramFitLevel(easy, usable)).toBe('easy')
    expect(vramFitLevel(easy + 1, usable)).toBe('tight')
    expect(vramFitLevel(usable, usable)).toBe('tight')
    expect(vramFitLevel(usable + 1, usable)).toBe('over')
  })

  it('is over budget when nothing is usable', () => {
    expect(vramFitLevel(0, 0)).toBe('over')
  })
})

describe('vramFitBars', () => {
  const usable = emptyCardBudgetBytes(CARD)
  const easy = usable * VRAM_EASY_FRACTION

  it('splits an easy fit at half its threshold and fills the gauge when tight', () => {
    expect(vramFitBars(easy / 2, usable)).toBe(1)
    expect(vramFitBars(easy / 2 + 1, usable)).toBe(2)
    expect(vramFitBars(easy, usable)).toBe(2)
    expect(vramFitBars(easy + 1, usable)).toBe(3)
    expect(vramFitBars(usable, usable)).toBe(3)
  })
})
