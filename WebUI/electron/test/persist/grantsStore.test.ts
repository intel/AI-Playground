import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => ({ real: '', demo: '' }))
let tmpRoot = ''

vi.mock('../../persist/userDataPaths.ts', () => ({
  getPermissionGrantsFile: () => files.real,
  getPermissionGrantsDemoFile: () => files.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  grantPermission,
  hasPermissionGrant,
  listPermissionGrants,
  migratePermissionGrants,
  resetPermissionGrantsForTest,
  revokePermissionGrant,
  setPermissionGrantsDeps,
  wipeDemoPermissionGrants,
} = await import('../../persist/grantsStore')

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-grants-'))
  files.real = path.join(tmpRoot, 'permission-grants.json')
  files.demo = path.join(tmpRoot, 'permission-grants-demo.json')
  resetPermissionGrantsForTest()
  setPermissionGrantsDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetPermissionGrantsForTest()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('permission grants store', () => {
  it('starts empty and remembers a pre-grant', async () => {
    expect(await listPermissionGrants()).toEqual([])
    const grant = await grantPermission('download:remote-turns', 'pre-grant')
    expect(grant.key).toBe('download:remote-turns')
    expect(await hasPermissionGrant('download:remote-turns')).toBe(true)
    expect((await listPermissionGrants())[0]?.origin).toBe('pre-grant')
  })

  it('revokes a grant so the next lookup is empty', async () => {
    await grantPermission('vram-warning:LTX-Video', 'remember')
    await revokePermissionGrant('vram-warning:LTX-Video')
    expect(await hasPermissionGrant('vram-warning:LTX-Video')).toBe(false)
  })

  it('migrates leftover keys without overwriting an existing grant', async () => {
    await grantPermission('download:remote-turns', 'pre-grant')
    const added = await migratePermissionGrants({
      'download:remote-turns': {
        key: 'download:remote-turns',
        origin: 'remember',
        createdAt: 1,
      },
      'vram-warning:LTX-Video': {
        key: 'vram-warning:LTX-Video',
        origin: 'remember',
        createdAt: 2,
      },
    })
    expect(added).toBe(1)
    expect(
      (await listPermissionGrants()).find((g) => g.key === 'download:remote-turns')?.origin,
    ).toBe('pre-grant')
    expect(await hasPermissionGrant('vram-warning:LTX-Video')).toBe(true)
  })

  it('rejects a grant key that looks like a path', async () => {
    await expect(grantPermission('../escape', 'remember')).rejects.toThrow('invalid')
  })

  it('routes demo writes to the demo file and wipe removes it', async () => {
    setPermissionGrantsDeps({ isDemoMode: () => true })
    await grantPermission('download:remote-turns', 'pre-grant')
    expect(await fs.readFile(files.demo, 'utf8')).toContain('download:remote-turns')
    await wipeDemoPermissionGrants()
    await expect(fs.access(files.demo)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
