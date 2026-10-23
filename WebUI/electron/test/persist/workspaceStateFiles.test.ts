import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The kernel's one-writer agent-workspace store (architecture-target §6.1,
// step 8). Driven against a real file in a temp dir: the section-shaped
// read/write/migrate contract, schema rejection of a corrupt file or
// payload, and demo routing + wipe.

const files = vi.hoisted(() => ({ real: '', demo: '' }))
let tmpRoot = ''

vi.mock('../../persist/userDataPaths.ts', () => ({
  getAgentWorkspaceFile: () => files.real,
  getAgentWorkspaceDemoFile: () => files.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  migrateAgentWorkspaceState,
  readAgentWorkspaceState,
  resetAgentWorkspaceFilesForTest,
  setAgentWorkspaceFilesDeps,
  wipeDemoAgentWorkspace,
  writeAgentWorkspaceState,
} = await import('../../persist/workspaceStateFiles')

const STATE = {
  workspaceDir: '/home/user/projects/game',
  lastWorkspaceByKind: { pick: '/p', games: '/g' },
}

const asRecord = (value: unknown) => value as Record<string, unknown>

async function readRaw(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetAgentWorkspaceFilesForTest()
  if (!tmpRoot) {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-agent-workspace-'))
  }
  files.real = path.join(tmpRoot, 'agent-workspace.json')
  files.demo = path.join(tmpRoot, 'agent-workspace-demo.json')
  for (const file of [files.real, files.demo]) await fs.rm(file, { force: true })
  setAgentWorkspaceFilesDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetAgentWorkspaceFilesForTest()
})

describe('the kernel agent workspace file store', () => {
  it('reads an absent file as null (the never-migrated state)', async () => {
    expect(await readAgentWorkspaceState()).toBeNull()
  })

  it('writes the state into a fresh file with a schema version', async () => {
    await writeAgentWorkspaceState(STATE)
    const raw = asRecord(await readRaw(files.real))
    expect(raw?.schemaVersion).toBe(1)
    expect(raw?.workspaceDir).toBe(STATE.workspaceDir)
    expect(raw?.lastWorkspaceByKind).toEqual(STATE.lastWorkspaceByKind)
  })

  it('replaces the state without leaving stale kinds behind', async () => {
    await writeAgentWorkspaceState(STATE)
    const next = { workspaceDir: '', lastWorkspaceByKind: { pick: '/p' } }
    await writeAgentWorkspaceState(next)
    expect(await readAgentWorkspaceState()).toEqual(next)
  })

  it('rejects a payload that is not the section shape', async () => {
    await expect(writeAgentWorkspaceState({ wrong: true })).rejects.toThrow(
      /invalid agent workspace state/,
    )
    await expect(
      writeAgentWorkspaceState({ workspaceDir: 5, lastWorkspaceByKind: {} }),
    ).rejects.toThrow(/invalid agent workspace state/)
    expect(await readRaw(files.real)).toBeNull()
  })

  it('migrates only when the file is absent', async () => {
    expect(await migrateAgentWorkspaceState(STATE)).toBe(true)
    expect(
      await migrateAgentWorkspaceState({ workspaceDir: '/other', lastWorkspaceByKind: {} }),
    ).toBe(false)
    expect(await readAgentWorkspaceState()).toEqual(STATE)
  })

  it('treats a corrupt file as a failed read, not as never-migrated', async () => {
    await fs.writeFile(files.real, 'not json', 'utf8')
    await expect(readAgentWorkspaceState()).rejects.toThrow(/unreadable/)
    await expect(migrateAgentWorkspaceState(STATE)).rejects.toThrow(/unreadable/)
    expect(await fs.readFile(files.real, 'utf8')).toBe('not json')
  })

  it('replaces a corrupt file on the next write', async () => {
    await fs.writeFile(files.real, 'not json', 'utf8')
    await writeAgentWorkspaceState(STATE)
    expect(await readAgentWorkspaceState()).toEqual(STATE)
  })

  it('treats a schema-invalid file as unreadable too', async () => {
    await fs.writeFile(
      files.real,
      JSON.stringify({ schemaVersion: 1, workspaceDir: '/x', lastWorkspaceByKind: 'nope' }),
      'utf8',
    )
    await expect(readAgentWorkspaceState()).rejects.toThrow(/unreadable/)
    await expect(migrateAgentWorkspaceState(STATE)).rejects.toThrow(/unreadable/)
  })

  it('routes writes through the demo file when demo mode is on', async () => {
    setAgentWorkspaceFilesDeps({ isDemoMode: () => true })
    await writeAgentWorkspaceState(STATE)
    expect(await readRaw(files.real)).toBeNull()
    expect((await readRaw(files.demo))?.workspaceDir).toBe(STATE.workspaceDir)
  })

  it('wipes only the demo file', async () => {
    await writeAgentWorkspaceState(STATE)
    setAgentWorkspaceFilesDeps({ isDemoMode: () => true })
    await writeAgentWorkspaceState({ workspaceDir: '/demo', lastWorkspaceByKind: {} })
    await wipeDemoAgentWorkspace()
    expect(await readRaw(files.demo)).toBeNull()
    setAgentWorkspaceFilesDeps({ isDemoMode: () => false })
    expect(await readAgentWorkspaceState()).toEqual(STATE)
  })

  it('round-trips empty defaults', async () => {
    await writeAgentWorkspaceState({ workspaceDir: '', lastWorkspaceByKind: {} })
    expect(await readAgentWorkspaceState()).toEqual({ workspaceDir: '', lastWorkspaceByKind: {} })
  })
})
