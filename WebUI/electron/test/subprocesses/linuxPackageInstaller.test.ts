import { describe, it, expect, vi, beforeEach } from 'vitest'

const execMock = vi.fn()

vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => execMock(...args),
}))

// isAptPackageInstalled is imported after the mock so promisify(exec) picks it up.
const { isAptPackageInstalled } = await import('../../subprocesses/linuxPackageInstaller')

function mockDpkgQueryOutput(stdout: string) {
  execMock.mockImplementation((_cmd: string, cb: (err: unknown, result: unknown) => void) => {
    cb(null, { stdout, stderr: '' })
  })
}

function mockDpkgQueryError() {
  execMock.mockImplementation((_cmd: string, cb: (err: unknown, result: unknown) => void) => {
    cb(new Error('no packages found matching pkg'), null)
  })
}

describe('isAptPackageInstalled', () => {
  beforeEach(() => {
    execMock.mockReset()
  })

  it('returns true for a normal single-architecture match', async () => {
    mockDpkgQueryOutput('installed')
    await expect(isAptPackageInstalled('libgomp1')).resolves.toBe(true)
  })

  it('returns true when dpkg-query concatenates statuses for a multiarch package', async () => {
    // Reproduces the real output on a system with both amd64 and i386 installed
    // (e.g. i386 pulled in by Wine/Steam), which previously broke the exact
    // string-equality check.
    mockDpkgQueryOutput('installedinstalled')
    await expect(isAptPackageInstalled('libgomp1')).resolves.toBe(true)
  })

  it('returns false when the package is not installed', async () => {
    mockDpkgQueryOutput('not-installed')
    await expect(isAptPackageInstalled('libgomp1')).resolves.toBe(false)
  })

  it('returns false when dpkg-query errors (package unknown)', async () => {
    mockDpkgQueryError()
    await expect(isAptPackageInstalled('does-not-exist')).resolves.toBe(false)
  })
})
