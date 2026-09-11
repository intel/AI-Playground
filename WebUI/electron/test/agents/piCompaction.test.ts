import { describe, expect, it } from 'vitest'
import { compactionSettingsForWindow, outputTokenBudget } from '../../agentMode/piCompaction.ts'

// Pi's 16k/20k compaction defaults cannot fit in a 32k window: keep already sits
// above the auto-compact trigger, so a "successful" compact still overflows n_ctx.
// These numbers have to keep that from happening without changing the 128k path.

function fits(window: number): void {
  const { reserveTokens, keepRecentTokens, enabled } = compactionSettingsForWindow(window)
  expect(enabled).toBe(true)
  expect(keepRecentTokens + reserveTokens).toBeLessThan(window)
  expect(keepRecentTokens).toBeLessThan(window - reserveTokens)
  const localGen = outputTokenBudget(window, 'local')
  expect(keepRecentTokens + localGen).toBeLessThanOrEqual(window)
}

describe('compactionSettingsForWindow', () => {
  it('scales reserve and keep so a 32k window can compact', () => {
    const { reserveTokens, keepRecentTokens } = compactionSettingsForWindow(32768)
    expect(reserveTokens).toBe(8192)
    expect(keepRecentTokens).toBe(10922)
    fits(32768)
  })

  it('keeps Pi defaults on a window that can hold them', () => {
    expect(compactionSettingsForWindow(131072)).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    })
    fits(131072)
  })

  it('fits every window the settings UI offers', () => {
    for (const window of [8192, 16384, 32768, 65536, 131072]) fits(window)
  })
})

describe('outputTokenBudget', () => {
  it('leaves a local model room for a whole file on a 128k window', () => {
    expect(outputTokenBudget(131072, 'local')).toBe(32768)
  })

  it('keeps half of a small window for the conversation', () => {
    expect(outputTokenBudget(8192, 'local')).toBe(4096)
  })

  it('allows a cloud model its own target', () => {
    expect(outputTokenBudget(128000, 'cloud')).toBe(16384)
  })
})
