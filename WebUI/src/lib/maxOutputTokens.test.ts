import { describe, it, expect } from 'vitest'
import { boundMaxOutputTokens } from './maxOutputTokens'

describe('boundMaxOutputTokens', () => {
  it('leaves a setting the window can hold alone', () => {
    expect(boundMaxOutputTokens(1024, 32768)).toBe(1024)
  })

  it('caps a setting larger than the whole window', () => {
    // The shipped case: the Assistant preset's 32768 against TinyLlama's 2048, which
    // OVMS rejected outright ("prompt tokens: 95 + max tokens value: 32768 exceeds
    // model max length: 2048") rather than truncating.
    expect(boundMaxOutputTokens(32768, 2048)).toBe(1024)
  })

  it('always leaves room for a prompt', () => {
    for (const window of [512, 2048, 8192, 32768, 131072]) {
      const bounded = boundMaxOutputTokens(Number.MAX_SAFE_INTEGER, window)
      expect(bounded).toBeLessThan(window)
    }
  })

  it('passes the setting through when the window is unknown', () => {
    // An unrecognized model, or a cloud provider that published no context_length —
    // capping against an invented number would be worse than not capping.
    expect(boundMaxOutputTokens(32768, undefined)).toBe(32768)
    expect(boundMaxOutputTokens(32768, 0)).toBe(32768)
  })

  it('never returns a non-positive budget', () => {
    expect(boundMaxOutputTokens(4096, 1)).toBe(1)
  })
})
