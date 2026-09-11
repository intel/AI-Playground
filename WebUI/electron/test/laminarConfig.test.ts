import { beforeEach, describe, expect, it, vi } from 'vitest'

// The config file is the whole on/off switch for tracing — an installed build
// reads it the same way a dev one does — so a file that is absent, malformed or
// in a folder that cannot even be named must leave the app running untraced.

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => '/tmp' },
}))

vi.mock('@lmnr-ai/lmnr', () => ({ Laminar: { initialized: () => true } }))

const warnings: string[] = []
vi.mock('../logging/logger.ts', () => ({
  appLoggerInstance: {
    info: vi.fn(),
    error: vi.fn(),
    warn: (message: string) => warnings.push(message),
  },
}))

/** What `externalResourcesDir()` does this run: a folder, or a throw. */
let resourcesDir: () => string
vi.mock('../util.ts', () => ({ externalResourcesDir: () => resourcesDir() }))

/** Contents keyed by file name; anything absent reads as ENOENT. */
let files: Record<string, string> = {}
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const original = actual.readFileSync as (file: unknown, ...rest: unknown[]) => unknown
  const readFileSync = (file: unknown, ...rest: unknown[]) => {
    const name = String(file).split(/[\\/]/).pop() ?? ''
    if (!name.startsWith('laminar.')) return original(file, ...rest)
    const contents = files[name]
    if (contents === undefined) {
      const error = new Error(`ENOENT: ${name}`) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    return contents
  }
  const namespace = { ...actual, readFileSync }
  return { ...namespace, default: namespace }
})

async function loadConfig() {
  vi.resetModules()
  const { laminarConfig } = await import('../laminar.ts')
  return laminarConfig()
}

describe('laminar config', () => {
  beforeEach(() => {
    warnings.length = 0
    files = {}
    resourcesDir = () => '/resources'
  })

  it('is off without a config file, and says nothing about it', async () => {
    expect(await loadConfig()).toBeNull()
    expect(warnings).toEqual([])
  })

  it('reads a config wherever the app keeps its external resources', async () => {
    files['laminar.dev.json'] = JSON.stringify({
      projectApiKey: 'key',
      baseUrl: 'https://api.example.com/',
      httpPort: 443,
    })

    expect(await loadConfig()).toMatchObject({
      projectApiKey: 'key',
      baseUrl: 'https://api.example.com',
      httpPort: 443,
    })
  })

  it('prefers the team instance over the local one', async () => {
    files['laminar.dev.json'] = JSON.stringify({ projectApiKey: 'team' })
    files['laminar.localhost.json'] = JSON.stringify({ projectApiKey: 'local' })

    expect(await loadConfig()).toMatchObject({ projectApiKey: 'team' })
  })

  it('falls through a malformed file to the next one', async () => {
    files['laminar.dev.json'] = '{ not json'
    files['laminar.localhost.json'] = JSON.stringify({ projectApiKey: 'local' })

    expect(await loadConfig()).toMatchObject({ projectApiKey: 'local' })
    expect(warnings.join()).toContain('laminar.dev.json')
  })

  it('stays off when the resources folder cannot be resolved', async () => {
    resourcesDir = () => {
      throw new Error('no resourcesPath')
    }

    expect(await loadConfig()).toBeNull()
    expect(warnings.join()).toContain('no resourcesPath')
  })
})
