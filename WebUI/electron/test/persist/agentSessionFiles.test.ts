import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The kernel's one-writer agent-session store (architecture-target §6.1,
// step 8). Driven against real files in a temp dir: bootstrap, the one-shot
// legacy upload, record upserts with save-time sanitize, deletes, demo
// routing, and the corrupt-index rebuild.

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getAgentSessionsDir: () => dirs.real,
  getAgentSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { appLoggerInstance } = await import('../../observability/logger')
const {
  bootstrapAgentSessions,
  deleteAgentSessionRecord,
  migrateLegacyAgentSessions,
  resetAgentSessionFilesForTest,
  saveAgentSession,
  saveAgentSessionActiveId,
  setAgentSessionFileDeps,
  wipeDemoAgentSessions,
} = await import('../../persist/agentSessionFiles')

const record = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  workspaceDir: '/games/space-dodger',
  title: 'dodge asteroids',
  createdAt: 1,
  updatedAt: 2,
  capabilities: ['game-studio'],
  presetName: 'Game Agent',
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'dodge asteroids' }] }],
  ...overrides,
})

/** An assistant tool part stuck mid-call — what a crash mid-turn would persist. */
const orphanedToolMessage = () => ({
  id: 'a-tool',
  role: 'assistant',
  parts: [
    {
      type: 'tool-game',
      toolCallId: 'call-1',
      state: 'input-available',
      input: { action: 'probe' },
    },
  ],
})

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function listDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => [])
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-agent-sessions-'))
  dirs.real = path.join(root, 'real')
  dirs.demo = path.join(root, 'demo')
})

let demoMode = false

beforeEach(async () => {
  resetAgentSessionFilesForTest()
  demoMode = false
  setAgentSessionFileDeps({ isDemoMode: () => demoMode })
  vi.mocked(appLoggerInstance.warn).mockClear()
})

afterEach(async () => {
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.demo, { recursive: true, force: true })
  resetAgentSessionFilesForTest()
})

describe('bootstrapAgentSessions', () => {
  it('reports empty on a fresh install', async () => {
    await expect(bootstrapAgentSessions()).resolves.toEqual({ status: 'empty' })
  })

  it('hydrates records and the active id written by a migration', async () => {
    await migrateLegacyAgentSessions({
      sessions: { 'aipg-agent-1': record('aipg-agent-1') },
      activeSessionId: 'aipg-agent-1',
    })
    const boot = await bootstrapAgentSessions()
    expect(boot).toMatchObject({ status: 'ok', activeSessionId: 'aipg-agent-1' })
    if (boot.status !== 'ok') return
    expect(boot.sessions).toHaveLength(1)
    expect(boot.sessions[0]).toMatchObject({ id: 'aipg-agent-1', presetName: 'Game Agent' })
  })

  it('rebuilds a corrupt index from the session files', async () => {
    await saveAgentSession(record('aipg-agent-1'))
    await fs.writeFile(path.join(dirs.real, 'index.json'), '{ not json', 'utf8')

    const boot = await bootstrapAgentSessions()
    expect(boot).toMatchObject({ status: 'ok' })
    if (boot.status !== 'ok') return
    expect(boot.sessions.map((session) => session.id)).toEqual(['aipg-agent-1'])
    // A rebuilt index honestly does not know which session was open.
    expect(boot.activeSessionId).toBeNull()
  })

  it('hydrates a corrupt session file as a placeholder so the id stays listed', async () => {
    await saveAgentSession(record('aipg-agent-1', { updatedAt: 9 }))
    const file = path.join(dirs.real, 'aipg-agent-1.json')
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, id: 'aipg-agent-1' }), 'utf8')

    const boot = await bootstrapAgentSessions()
    if (boot.status !== 'ok') throw new Error('expected ok')
    expect(boot.sessions).toEqual([
      {
        id: 'aipg-agent-1',
        workspaceDir: '',
        title: 'Unavailable session',
        createdAt: 9,
        updatedAt: 9,
        messages: [],
      },
    ])
  })

  it('rebuilds from session files when index.json is missing but records remain', async () => {
    await saveAgentSession(record('aipg-agent-1'))
    await fs.rm(path.join(dirs.real, 'index.json'))
    const boot = await bootstrapAgentSessions()
    expect(boot).toMatchObject({ status: 'ok' })
    if (boot.status !== 'ok') return
    expect(boot.sessions.map((session) => session.id)).toEqual(['aipg-agent-1'])
    expect(boot.activeSessionId).toBeNull()
  })

  it('rebuilds from session files when index.json fails schema', async () => {
    await saveAgentSession(record('aipg-agent-1'))
    await fs.writeFile(
      path.join(dirs.real, 'index.json'),
      `${JSON.stringify({ schemaVersion: 99, sessions: [] })}\n`,
      'utf8',
    )
    const boot = await bootstrapAgentSessions()
    expect(boot).toMatchObject({ status: 'ok' })
    if (boot.status !== 'ok') return
    expect(boot.sessions.map((session) => session.id)).toEqual(['aipg-agent-1'])
  })
})

describe('migrateLegacyAgentSessions', () => {
  it('merges into an existing index instead of refusing (the stranded-records rescue)', async () => {
    const first = await migrateLegacyAgentSessions({
      sessions: { 'aipg-agent-1': record('aipg-agent-1') },
      activeSessionId: 'aipg-agent-1',
    })
    expect(first).toMatchObject({ status: 'ok' })

    const second = await migrateLegacyAgentSessions({
      sessions: { 'aipg-agent-2': record('aipg-agent-2') },
      activeSessionId: 'aipg-agent-2',
    })
    expect(second).toMatchObject({ status: 'ok', activeSessionId: 'aipg-agent-1' })
    if (second.status !== 'ok') return
    expect(second.sessions.map((session) => session.id).sort()).toEqual([
      'aipg-agent-1',
      'aipg-agent-2',
    ])
  })

  it('is idempotent: an id the files already hold is not written twice', async () => {
    await migrateLegacyAgentSessions({
      sessions: { 'aipg-agent-1': record('aipg-agent-1', { title: 'first' }) },
      activeSessionId: 'aipg-agent-1',
    })
    const boot = await migrateLegacyAgentSessions({
      sessions: { 'aipg-agent-1': record('aipg-agent-1', { title: 'attacker' }) },
      activeSessionId: 'aipg-agent-1',
    })
    if (boot.status !== 'ok') throw new Error('expected ok')
    expect(boot.sessions.map((session) => session.title)).toEqual(['first'])
  })

  it('skips unsafe ids and records that fail the schema', async () => {
    const boot = await migrateLegacyAgentSessions({
      sessions: {
        '../escape': record('../escape'),
        'aipg-agent-1': record('aipg-agent-1'),
        'aipg-agent-bad': { id: 'aipg-agent-bad', noTimestampsHere: true },
      },
      activeSessionId: null,
    })
    if (boot.status !== 'ok') throw new Error('expected ok')
    expect(boot.sessions.map((session) => session.id)).toEqual(['aipg-agent-1'])
  })

  it('does not store an unsafe legacy activeSessionId', async () => {
    const boot = await migrateLegacyAgentSessions({
      sessions: { 'aipg-agent-1': record('aipg-agent-1') },
      activeSessionId: '../escape',
    })
    expect(boot).toMatchObject({ status: 'ok', activeSessionId: null })
  })
})

describe('saveAgentSession', () => {
  it('writes the record atomically and upserts its index entry', async () => {
    await saveAgentSession(record('aipg-agent-1', { updatedAt: 5 }))
    const doc = await readJson(path.join(dirs.real, 'aipg-agent-1.json'))
    expect(doc.schemaVersion).toBe(1)
    expect(doc.title).toBe('dodge asteroids')

    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect(index).toMatchObject({
      schemaVersion: 1,
      activeSessionId: null,
      sessions: [{ id: 'aipg-agent-1', updatedAt: 5 }],
    })

    await saveAgentSession(record('aipg-agent-1', { updatedAt: 9 }))
    const indexAgain = await readJson(path.join(dirs.real, 'index.json'))
    expect(indexAgain.sessions).toEqual([{ id: 'aipg-agent-1', updatedAt: 9 }])
  })

  it('repairs an orphaned tool call before the file is written', async () => {
    await saveAgentSession(record('aipg-agent-1', { messages: [orphanedToolMessage()] as never }))
    const doc = await readJson(path.join(dirs.real, 'aipg-agent-1.json'))
    const messages = doc.messages as { parts: { state?: string; errorText?: string }[] }[]
    const toolPart = messages[0].parts[0]
    expect(toolPart.state).toBe('output-error')
    expect(toolPart.errorText).toContain('interrupted')
  })

  it('routes to the demo directory and the wipe removes it', async () => {
    demoMode = true
    await saveAgentSession(record('aipg-agent-1'))
    expect((await listDir(dirs.demo)).sort()).toEqual(['aipg-agent-1.json', 'index.json'])
    expect(await listDir(dirs.real)).toEqual([])

    await wipeDemoAgentSessions()
    expect(await listDir(dirs.demo)).toEqual([])
  })

  it('orders concurrent saves of different sessions through the index', async () => {
    await Promise.all([
      saveAgentSession(record('aipg-agent-1')),
      saveAgentSession(record('aipg-agent-2')),
      saveAgentSessionActiveId('aipg-agent-2'),
    ])
    const index = await readJson(path.join(dirs.real, 'index.json'))
    const ids = (index.sessions as { id: string }[]).map((entry) => entry.id).sort()
    expect(ids).toEqual(['aipg-agent-1', 'aipg-agent-2'])
    expect(index.activeSessionId).toBe('aipg-agent-2')
  })

  it('rejects an id that would overwrite index.json', async () => {
    await expect(saveAgentSession(record('index'))).rejects.toThrow(/invalid agent session id/)
    expect(await listDir(dirs.real)).toEqual([])
  })

  it('rejects a path-shaped id', async () => {
    await expect(saveAgentSession(record('../x'))).rejects.toThrow(/invalid agent session id/)
    expect(await listDir(dirs.real)).toEqual([])
  })
})

describe('deleteAgentSessionRecord', () => {
  it('removes the file and the index entry', async () => {
    await saveAgentSession(record('aipg-agent-1'))
    await saveAgentSession(record('aipg-agent-2'))

    await expect(deleteAgentSessionRecord('aipg-agent-1')).resolves.toEqual({ success: true })
    expect((await listDir(dirs.real)).sort()).toEqual(['aipg-agent-2.json', 'index.json'])
    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect((index.sessions as { id: string }[]).map((entry) => entry.id)).toEqual(['aipg-agent-2'])
  })

  it('reports failure when the file cannot be removed', async () => {
    // Make the record's path a directory, so `rm` without `recursive` fails.
    await fs.mkdir(path.join(dirs.real, 'aipg-agent-1.json'), { recursive: true })
    const result = await deleteAgentSessionRecord('aipg-agent-1')
    expect(result.success).toBe(false)
    expect('error' in result && result.error).toBeTruthy()
  })
})
