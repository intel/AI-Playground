import { describe, expect, it } from 'vitest'
import {
  APPLICATION_CONTROL_USER_MESSAGE,
  applicationControlHint,
  isApplicationControlBlock,
  withApplicationControlHint,
} from '../../../adapters/backends/applicationControl.ts'

describe('isApplicationControlBlock', () => {
  it('matches uv failing to spawn a blocked interpreter', () => {
    const text =
      'error: Failed to spawn: `python.exe`\n  Caused by: An Application Control policy has blocked this file. (os error 4551)'
    expect(isApplicationControlBlock({ text })).toBe(true)
    expect(applicationControlHint({ text })).toBe(APPLICATION_CONTROL_USER_MESSAGE)
  })

  it('matches Python failing to import a blocked extension', () => {
    const text =
      'ImportError: DLL load failed while importing _core: An Application Control policy has blocked this file.'
    expect(isApplicationControlBlock({ text })).toBe(true)
    expect(applicationControlHint({ text })).toBe(APPLICATION_CONTROL_USER_MESSAGE)
  })

  it('matches the Win32 name of error 4551', () => {
    expect(isApplicationControlBlock({ text: 'CreateProcess failed: ERROR_VIRUS_INFECTED' })).toBe(
      true,
    )
  })

  it('treats a Windows spawn UNKNOWN as a blocked CreateProcess', () => {
    expect(
      isApplicationControlBlock({
        text: 'spawn UNKNOWN',
        code: 'UNKNOWN',
        syscall: 'spawn',
        platform: 'win32',
      }),
    ).toBe(true)
  })

  it('does not treat spawn UNKNOWN as a block on other platforms', () => {
    expect(
      isApplicationControlBlock({
        text: 'spawn UNKNOWN',
        code: 'UNKNOWN',
        syscall: 'spawn',
        platform: 'linux',
      }),
    ).toBe(false)
  })

  it('does not match a bare 4551 in an unrelated log line', () => {
    expect(isApplicationControlBlock({ text: 'listening on port 4551' })).toBe(false)
    expect(
      isApplicationControlBlock({
        text: 'sha256 f5764d546ff9a2511b50ec4e20424c5f4669de1695abc3fa4128e7f7d4a7b2cd4551',
      }),
    ).toBe(false)
    expect(
      isApplicationControlBlock({ text: 'No solution found when resolving dependencies' }),
    ).toBe(false)
    expect(applicationControlHint({ text: 'not enough memory to run the model' })).toBeUndefined()
  })
})

describe('withApplicationControlHint', () => {
  it('restores the hint when ComfyUI merges the startup log into the mismatch warning', () => {
    const merged = withApplicationControlHint({
      stdout: '=== Environment Mismatch Warning ===\nVirtual environment detected',
      stderr: [
        '=== Environment Mismatch Warning ===',
        'Environment mismatch detected.',
        '',
        '=== Startup Error Details ===',
        'ImportError: DLL load failed while importing _core: An Application Control policy has blocked this file.',
      ].join('\n'),
    })
    expect(merged.hint).toBe(APPLICATION_CONTROL_USER_MESSAGE)
  })

  it('keeps a hint that was already attached', () => {
    const details = withApplicationControlHint({
      stdout: 'listening on port 4551',
      stderr: 'not enough memory',
      hint: APPLICATION_CONTROL_USER_MESSAGE,
    })
    expect(details.hint).toBe(APPLICATION_CONTROL_USER_MESSAGE)
  })
})
