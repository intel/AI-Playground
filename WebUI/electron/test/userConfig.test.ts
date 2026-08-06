import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The module under test resolves its two roots through aipgRoot; mock those so we
// can drive the shared (roots differ) vs. non-shared (roots equal) branches with
// real temp directories and assert the seeding behaviour.
let resourcesRoot = ''
let configRoot = ''
vi.mock('../aipgRoot.ts', () => ({
  packagedResourcesRoot: () => resourcesRoot,
  writableConfigRoot: () => configRoot,
}))

import { writableConfigFile } from '../userConfig.ts'

let tmpBase = ''
let counter = 0

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `aipg-userconfig-${process.pid}-${counter++}-`))
  resourcesRoot = path.join(tmpBase, 'resources')
  configRoot = path.join(tmpBase, 'config')
  fs.mkdirSync(resourcesRoot, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true })
})

describe('writableConfigFile', () => {
  it('is a passthrough (no seeding) when config root equals the resources root', () => {
    configRoot = resourcesRoot // non-shared mode: roots are identical

    const result = writableConfigFile('mcp.json')

    expect(result).toBe(path.join(resourcesRoot, 'mcp.json'))
    // Must not create anything — behaviour outside shared mode is unchanged.
    expect(fs.existsSync(path.join(resourcesRoot, 'mcp.json'))).toBe(false)
  })

  it('seeds the per-user copy from the shared default on first use (shared mode)', () => {
    fs.writeFileSync(path.join(resourcesRoot, 'mcp.json'), '{"mcpServers":{}}', 'utf-8')

    const result = writableConfigFile('mcp.json')

    expect(result).toBe(path.join(configRoot, 'mcp.json'))
    expect(fs.existsSync(result)).toBe(true)
    expect(fs.readFileSync(result, 'utf-8')).toBe('{"mcpServers":{}}')
  })

  it('does not overwrite an existing per-user copy with the shared default', () => {
    fs.writeFileSync(path.join(resourcesRoot, 'mcp.json'), '{"shared":true}', 'utf-8')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.writeFileSync(path.join(configRoot, 'mcp.json'), '{"userEdited":true}', 'utf-8')

    const result = writableConfigFile('mcp.json')

    expect(fs.readFileSync(result, 'utf-8')).toBe('{"userEdited":true}')
  })

  it('returns the target path without throwing when no shared default exists', () => {
    // No seed file in resourcesRoot.
    const result = writableConfigFile('model_config.json')

    expect(result).toBe(path.join(configRoot, 'model_config.json'))
    expect(fs.existsSync(result)).toBe(false)
  })
})
