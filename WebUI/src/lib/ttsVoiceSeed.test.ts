import { describe, expect, it } from 'vitest'
import { randomVoiceSeed, seedForVoice, stableVoiceSeed } from './ttsVoiceSeed'

describe('stableVoiceSeed', () => {
  it('is deterministic for the same name + description', () => {
    const a = stableVoiceSeed('Tammy', 'A calm middle-aged British woman.')
    const b = stableVoiceSeed('Tammy', 'A calm middle-aged British woman.')
    expect(a).toBe(b)
  })

  it('ignores name casing and surrounding whitespace', () => {
    expect(stableVoiceSeed(' tammy ', ' A calm voice. ')).toBe(
      stableVoiceSeed('Tammy', 'A calm voice.'),
    )
  })

  it('differs when the description changes', () => {
    expect(stableVoiceSeed('Tammy', 'A calm voice.')).not.toBe(
      stableVoiceSeed('Tammy', 'A booming voice.'),
    )
  })

  it('stays inside the int32 range torch accepts', () => {
    for (const text of ['a', 'Tammy', 'x'.repeat(500), '🎙️ voice']) {
      const seed = stableVoiceSeed(text, text)
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThan(2 ** 31)
    }
  })
})

describe('seedForVoice', () => {
  it('prefers the pinned seed', () => {
    expect(seedForVoice({ name: 'Tammy', instruct: 'A calm voice.', seed: 42 })).toBe(42)
  })

  it('accepts a pinned seed of 0', () => {
    expect(seedForVoice({ name: 'Tammy', instruct: 'A calm voice.', seed: 0 })).toBe(0)
  })

  it('falls back to the derived seed for voices saved before seeds existed', () => {
    expect(seedForVoice({ name: 'Tammy', instruct: 'A calm voice.' })).toBe(
      stableVoiceSeed('Tammy', 'A calm voice.'),
    )
  })

  it('falls back when the pinned seed is outside the range torch accepts', () => {
    const derived = stableVoiceSeed('Tammy', 'A calm voice.')
    // A persisted voice can carry anything; -1 and 2**31 are the two edges the
    // generators never produce, and either would fail the synthesis outright.
    expect(seedForVoice({ name: 'Tammy', instruct: 'A calm voice.', seed: -1 })).toBe(derived)
    expect(seedForVoice({ name: 'Tammy', instruct: 'A calm voice.', seed: 2 ** 31 })).toBe(derived)
  })
})

describe('randomVoiceSeed', () => {
  it('produces integers in range', () => {
    for (let i = 0; i < 20; i++) {
      const seed = randomVoiceSeed()
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThan(2 ** 31)
    }
  })
})
