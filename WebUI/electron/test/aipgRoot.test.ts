import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// aipgRoot caches the shared-mode decision and the "seeded" flag at module scope,
// so each scenario loads a fresh module instance with its own electron /
// installConfig mocks via vi.resetModules() + dynamic import.
//
// All of %PUBLIC%, %LOCALAPPDATA% and process.resourcesPath are pointed at
// temp dirs so that shared mode — which seeds the shared root — never touches a
// real machine-wide location.

const origPlatform = process.platform
const origResourcesPath = (process as { resourcesPath?: string }).resourcesPath
const origPublic = process.env.PUBLIC
const origLocalAppData = process.env.LOCALAPPDATA

let tmpBase = ''
let tmpResources = ''
let tmpPublic = ''
let tmpLocalAppData = ''

function setProp(obj: object, key: string, value: unknown) {
  Object.defineProperty(obj, key, { value, configurable: true })
}

async function loadAipgRoot(opts: {
  isPackaged: boolean
  mode: 'shared' | 'per-user' | null
  platform: NodeJS.Platform
  sharedResourcesDir?: string
}) {
  vi.resetModules()
  setProp(process, 'platform', opts.platform)
  vi.doMock('electron', () => ({
    app: { isPackaged: opts.isPackaged, getVersion: () => '0.0.0-test' },
  }))
  vi.doMock('../installConfig.ts', () => ({
    readInstallConfig: () =>
      opts.mode
        ? { modelFolderMode: opts.mode, sharedResourcesDir: opts.sharedResourcesDir }
        : null,
  }))
  return import('../aipgRoot.ts')
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `aipg-root-${process.pid}-`))
  tmpResources = path.join(tmpBase, 'bundle')
  tmpPublic = path.join(tmpBase, 'Public')
  tmpLocalAppData = path.join(tmpBase, 'LocalAppData')
  fs.mkdirSync(tmpResources, { recursive: true })
  setProp(process, 'resourcesPath', tmpResources)
  process.env.PUBLIC = tmpPublic
  process.env.LOCALAPPDATA = tmpLocalAppData
})

afterEach(() => {
  vi.doUnmock('electron')
  vi.doUnmock('../installConfig.ts')
  vi.resetModules()
  setProp(process, 'platform', origPlatform)
  setProp(process, 'resourcesPath', origResourcesPath)
  process.env.PUBLIC = origPublic
  process.env.LOCALAPPDATA = origLocalAppData
  fs.rmSync(tmpBase, { recursive: true, force: true })
})

describe('writableConfigRoot', () => {
  it('is a private per-user config dir in a shared all-users install', async () => {
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })

    expect(mod.writableConfigRoot()).toBe(path.join(tmpLocalAppData, 'ai-playground', 'config'))
    // The shared branch resolves without hitting packagedResourcesRoot(), so the
    // two roots are distinct — that separation is the whole point of the feature.
    expect(mod.writableConfigRoot()).not.toBe(mod.packagedResourcesRoot())
  })

  it('equals the resources root for an all-users install without sharing', async () => {
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'per-user', platform: 'win32' })

    expect(mod.writableConfigRoot()).toBe(mod.packagedResourcesRoot())
  })

  it('ignores a "shared" config on non-Windows (guarded by platform)', async () => {
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'linux' })

    // Not win32 -> shared mode inactive -> config root equals the resources root.
    expect(mod.writableConfigRoot()).toBe(mod.packagedResourcesRoot())
  })

  it('equals the resources root in dev (unpackaged)', async () => {
    const mod = await loadAipgRoot({ isPackaged: false, mode: null, platform: 'win32' })

    expect(mod.writableConfigRoot()).toBe(mod.packagedResourcesRoot())
  })
})

describe('packagedResourcesRoot', () => {
  it('points at the machine-wide shared resources root in shared mode', async () => {
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })

    expect(mod.packagedResourcesRoot()).toBe(path.join(tmpPublic, 'AI Playground', 'resources'))
  })

  it('honors an admin-chosen shared resources base dir, appending the resources leaf', async () => {
    const customBase = path.join(tmpBase, 'CustomShared')
    const mod = await loadAipgRoot({
      isPackaged: true,
      mode: 'shared',
      platform: 'win32',
      sharedResourcesDir: customBase,
    })

    // The `resources` leaf is always appended so model_config's relative
    // `./resources/models` paths (anchored to path.dirname(root)) still resolve.
    expect(mod.packagedResourcesRoot()).toBe(path.join(customBase, 'resources'))
  })
})
