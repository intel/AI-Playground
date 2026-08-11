import { describe, it, expect } from 'vitest'
import { parseLocalWebPort } from '../../../src/assets/js/store/localWebPort'

describe('LAN chat port parsing', () => {
  it('accepts a port inside the allowed range', () => {
    expect(parseLocalWebPort('8765')).toBe(8765)
    expect(parseLocalWebPort('1024')).toBe(1024)
    expect(parseLocalWebPort('65535')).toBe(65535)
  })

  it('accepts a number as well as a string', () => {
    // Regression: the field is bound to an `<input type="number">`, where Vue
    // applies the `.number` modifier implicitly — so the ref holds a *number*
    // once the user edits it. Assuming a string threw on every keystroke and took
    // the whole computed chain (validation, error text, URL list) down with it.
    expect(parseLocalWebPort(8765)).toBe(8765)
    expect(parseLocalWebPort(80)).toBeNull()
  })

  it('rejects a port outside the allowed range', () => {
    // Silently substituting the default here started the server on a port the
    // user never asked for, and showed them addresses for it.
    expect(parseLocalWebPort('80')).toBeNull()
    expect(parseLocalWebPort('1023')).toBeNull()
    expect(parseLocalWebPort('65536')).toBeNull()
    expect(parseLocalWebPort('70000')).toBeNull()
    expect(parseLocalWebPort('0')).toBeNull()
  })

  it('rejects anything that is not a plain positive integer', () => {
    for (const raw of [
      '',
      '   ',
      'abc',
      '8765abc',
      '87.65',
      '-8765',
      '+8765',
      '0x22',
      null,
      undefined,
    ]) {
      expect(parseLocalWebPort(raw), `${JSON.stringify(raw)} must be rejected`).toBeNull()
    }
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseLocalWebPort('  8765 ')).toBe(8765)
  })
})
