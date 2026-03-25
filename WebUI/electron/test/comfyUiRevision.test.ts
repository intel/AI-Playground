import { describe, expect, it } from 'vitest'
import { normalizeComfyUiRef, useLockedComfyUiDeps } from '../subprocesses/comfyUiRevision'

describe('normalizeComfyUiRef', () => {
  it('trims and lowercases version tags', () => {
    expect(normalizeComfyUiRef('  V0.17.0  ')).toBe('v0.17.0')
  })

  it('lowercases hex commit hashes', () => {
    expect(normalizeComfyUiRef('ABCD1234')).toBe('abcd1234')
  })
})

describe('useLockedComfyUiDeps', () => {
  it('is true when requested ref matches bundled ref (case-insensitive tag)', () => {
    expect(useLockedComfyUiDeps('v0.10.0', 'v0.10.0')).toBe(true)
    expect(useLockedComfyUiDeps('V0.10.0', 'v0.10.0')).toBe(true)
  })

  it('is false when refs differ', () => {
    expect(useLockedComfyUiDeps('v0.17.0', 'v0.10.0')).toBe(false)
  })
})
