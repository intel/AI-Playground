import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isTrustedOwnerSid,
  normalizeLocalAbsolutePath,
  parseInstallRegistry,
  readInstallConfig,
  type InstallConfigProbe,
} from '../../kernel/installConfig.ts'

const sharedRegistry = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\AI Playground',
  '    modelFolderMode    REG_SZ    shared',
  '    sharedResourcesDir    REG_SZ    D:\\AI Playground',
  '',
].join('\r\n')

type DirKind = 'dir' | 'link' | 'file' | 'missing'

function lstatMap(entries: Record<string, DirKind>): InstallConfigProbe['lstat'] {
  return (dir) => {
    const kind = entries[dir] ?? 'missing'
    if (kind === 'missing') {
      const error = new Error(`ENOENT: ${dir}`) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    return {
      isDirectory: () => kind === 'dir',
      isSymbolicLink: () => kind === 'link',
    }
  }
}

function probe(overrides: Partial<InstallConfigProbe> = {}): InstallConfigProbe {
  return {
    registryStdout: sharedRegistry,
    ownerSid: () => 'S-1-5-32-544',
    lstat: lstatMap({
      'D:\\AI Playground': 'dir',
      'D:\\': 'dir',
      'D:\\AI Playground\\resources': 'missing',
    }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeLocalAbsolutePath', () => {
  it('accepts a drive-letter path and normalizes separators', () => {
    expect(normalizeLocalAbsolutePath('D:/AI Playground')).toBe('D:\\AI Playground')
    expect(normalizeLocalAbsolutePath('  D:\\AI Playground\\  ')).toBe('D:\\AI Playground')
  })

  it('rejects UNC, device, relative, and parent-segment paths', () => {
    expect(normalizeLocalAbsolutePath('\\\\server\\share')).toBeNull()
    expect(normalizeLocalAbsolutePath('//server/share')).toBeNull()
    expect(normalizeLocalAbsolutePath('\\\\?\\C:\\foo')).toBeNull()
    expect(normalizeLocalAbsolutePath('\\\\?\\UNC\\server\\share')).toBeNull()
    expect(normalizeLocalAbsolutePath('\\\\.\\PhysicalDrive0')).toBeNull()
    expect(normalizeLocalAbsolutePath('C:relative')).toBeNull()
    expect(normalizeLocalAbsolutePath('relative\\path')).toBeNull()
    expect(normalizeLocalAbsolutePath('..\\Windows')).toBeNull()
    expect(normalizeLocalAbsolutePath('D:\\foo\\..\\Windows')).toBeNull()
    expect(normalizeLocalAbsolutePath('')).toBeNull()
    expect(normalizeLocalAbsolutePath('D:\\foo\0bar')).toBeNull()
  })
})

describe('isTrustedOwnerSid', () => {
  it('accepts Administrators, SYSTEM, and TrustedInstaller', () => {
    expect(isTrustedOwnerSid('S-1-5-32-544')).toBe(true)
    expect(isTrustedOwnerSid(' s-1-5-18 ')).toBe(true)
    expect(isTrustedOwnerSid('S-1-5-80-956008885-3418522649')).toBe(true)
  })

  it('rejects a standard user and an empty sid', () => {
    expect(isTrustedOwnerSid('S-1-5-21-1-1001')).toBe(false)
    expect(isTrustedOwnerSid('S-1-5-80-')).toBe(false)
    expect(isTrustedOwnerSid(null)).toBe(false)
    expect(isTrustedOwnerSid('')).toBe(false)
  })
})

describe('parseInstallRegistry', () => {
  it('reads the mode and a path that contains spaces', () => {
    expect(parseInstallRegistry(sharedRegistry)).toEqual({
      modelFolderMode: 'shared',
      sharedResourcesDir: 'D:\\AI Playground',
    })
  })
})

describe('readInstallConfig', () => {
  it('returns null off Windows when nothing is injected', () => {
    if (process.platform === 'win32') return
    expect(readInstallConfig()).toBeNull()
  })

  it('accepts a shared config whose directory is admin-owned', () => {
    expect(readInstallConfig(probe())).toEqual({
      modelFolderMode: 'shared',
      sharedResourcesDir: 'D:\\AI Playground',
    })
  })

  it('accepts per-user mode and does not inspect a path', () => {
    const ownerSid = vi.fn(() => {
      throw new Error('owner should not be read')
    })
    expect(
      readInstallConfig(
        probe({
          registryStdout: '    modelFolderMode    REG_SZ    per-user\r\n',
          ownerSid,
        }),
      ),
    ).toEqual({ modelFolderMode: 'per-user' })
    expect(ownerSid).not.toHaveBeenCalled()
  })

  it('ignores a shared config whose path is a UNC path', () => {
    const lstat = vi.fn()
    expect(
      readInstallConfig(
        probe({
          registryStdout: sharedRegistry.replace('D:\\AI Playground', '\\\\server\\share'),
          lstat,
        }),
      ),
    ).toBeNull()
    expect(lstat).not.toHaveBeenCalled()
  })

  it('ignores a shared config when the directory is missing', () => {
    expect(readInstallConfig(probe({ lstat: lstatMap({}) }))).toBeNull()
  })

  it('ignores a shared config when an ancestor is a reparse point', () => {
    expect(
      readInstallConfig(
        probe({
          lstat: lstatMap({
            'D:\\AI Playground': 'dir',
            'D:\\': 'link',
          }),
        }),
      ),
    ).toBeNull()
  })

  it('ignores a shared config when the resources leaf is a link', () => {
    expect(
      readInstallConfig(
        probe({
          lstat: lstatMap({
            'D:\\AI Playground': 'dir',
            'D:\\': 'dir',
            'D:\\AI Playground\\resources': 'link',
          }),
        }),
      ),
    ).toBeNull()
  })

  it('ignores a shared config the current user owns', () => {
    expect(readInstallConfig(probe({ ownerSid: () => 'S-1-5-21-1-1001' }))).toBeNull()
    expect(readInstallConfig(probe({ ownerSid: () => null }))).toBeNull()
  })

  it('ignores an unknown mode', () => {
    expect(
      readInstallConfig(probe({ registryStdout: '    modelFolderMode    REG_SZ    whatever\r\n' })),
    ).toBeNull()
  })
})
