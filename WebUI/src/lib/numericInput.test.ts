import { describe, it, expect } from 'vitest'
import { sanitizeIntegerInput } from './numericInput'

const MAX_TOKENS = { fallback: 1024, min: 1, max: 4096 }

describe('sanitizeIntegerInput', () => {
  it('falls back when the field is cleared', () => {
    expect(sanitizeIntegerInput('', MAX_TOKENS)).toBe(1024)
    expect(sanitizeIntegerInput('   ', MAX_TOKENS)).toBe(1024)
  })

  it('falls back on null and undefined', () => {
    expect(sanitizeIntegerInput(null, MAX_TOKENS)).toBe(1024)
    expect(sanitizeIntegerInput(undefined, MAX_TOKENS)).toBe(1024)
  })

  it('falls back on values that are not numbers', () => {
    expect(sanitizeIntegerInput('abc', MAX_TOKENS)).toBe(1024)
    expect(sanitizeIntegerInput(Number.NaN, MAX_TOKENS)).toBe(1024)
    expect(sanitizeIntegerInput(Number.POSITIVE_INFINITY, MAX_TOKENS)).toBe(1024)
  })

  it('returns an integer for numeric strings', () => {
    expect(sanitizeIntegerInput('2048', MAX_TOKENS)).toBe(2048)
    expect(Number.isInteger(sanitizeIntegerInput('2048', MAX_TOKENS))).toBe(true)
  })

  it('truncates fractional input', () => {
    expect(sanitizeIntegerInput(2048.7, MAX_TOKENS)).toBe(2048)
    expect(sanitizeIntegerInput('2048.7', MAX_TOKENS)).toBe(2048)
  })

  it('clamps to the allowed range', () => {
    expect(sanitizeIntegerInput(0, MAX_TOKENS)).toBe(1)
    expect(sanitizeIntegerInput(-5, MAX_TOKENS)).toBe(1)
    expect(sanitizeIntegerInput(999999, MAX_TOKENS)).toBe(4096)
  })

  it('keeps values that are already valid', () => {
    expect(sanitizeIntegerInput(1, MAX_TOKENS)).toBe(1)
    expect(sanitizeIntegerInput(4096, MAX_TOKENS)).toBe(4096)
  })
})
