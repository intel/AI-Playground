import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

import { parseLdconfigOutput } from '../../subprocesses/openVINOBackendService'

describe('parseLdconfigOutput', () => {
  it('resolves a single-architecture soname to its path', () => {
    const output = '\tlibxml2.so.16 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libxml2.so.16\n'
    const map = parseLdconfigOutput(output)
    expect(map.get('libxml2.so.16')).toBe('/usr/lib/x86_64-linux-gnu/libxml2.so.16')
  })

  it('prefers the x86-64 entry over a foreign-arch entry listed after it', () => {
    // Reproduces real `ldconfig -p` output on a multiarch system (e.g. i386
    // pulled in by Wine/Steam) with both amd64 and i386 libxml2 installed.
    // The i386 line has no "x86-64" tag and appears after the x86-64 line.
    const output = [
      '\tlibxml2.so.16 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libxml2.so.16',
      '\tlibxml2.so.16 (libc6) => /usr/lib/i386-linux-gnu/libxml2.so.16',
      '',
    ].join('\n')
    const map = parseLdconfigOutput(output)
    expect(map.get('libxml2.so.16')).toBe('/usr/lib/x86_64-linux-gnu/libxml2.so.16')
  })

  it('prefers the x86-64 entry even when the foreign-arch entry is listed first', () => {
    const output = [
      '\tlibxml2.so.16 (libc6) => /usr/lib/i386-linux-gnu/libxml2.so.16',
      '\tlibxml2.so.16 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libxml2.so.16',
      '',
    ].join('\n')
    const map = parseLdconfigOutput(output)
    expect(map.get('libxml2.so.16')).toBe('/usr/lib/x86_64-linux-gnu/libxml2.so.16')
  })

  it('falls back to the only available entry when no x86-64 tag exists at all', () => {
    const output = '\tlibfoo.so.1 (libc6) => /usr/lib/i386-linux-gnu/libfoo.so.1\n'
    const map = parseLdconfigOutput(output)
    expect(map.get('libfoo.so.1')).toBe('/usr/lib/i386-linux-gnu/libfoo.so.1')
  })

  it('ignores unparsable lines', () => {
    const output = ['1234 libs found in cache `/etc/ld.so.cache\'', '\tnot a valid line', ''].join(
      '\n',
    )
    const map = parseLdconfigOutput(output)
    expect(map.size).toBe(0)
  })
})
