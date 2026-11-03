import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { createSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { appendHistoryEntry, readHistoryEntries } = await import('../../session/sessionHistory')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-history-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
})

function historyFile(id: string): string {
  return path.join(dirs.real, id, 'session-history.jsonl')
}

const imageTurn = {
  preset: 'Dummy Image (test)',
  variant: 'Fast',
  kind: 'image' as const,
  prompt: 'a red fox',
  status: 'completed' as const,
  artifacts: [{ path: 'files/fox.png', mediaType: 'image' as const }],
}

describe('Session History', () => {
  it('appends entries in order, one JSON line each', async () => {
    const { id } = await createSession()

    const first = await appendHistoryEntry(id, imageTurn)
    const second = await appendHistoryEntry(id, {
      ...imageTurn,
      preset: 'Dummy Edit (test)',
      kind: 'edit',
      prompt: 'make it blue',
      artifacts: [{ path: 'files/fox-blue.png', mediaType: 'image' }],
    })

    const lines = (await fs.readFile(historyFile(id), 'utf8')).split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ id: first.id, prompt: 'a red fox' })
    expect(JSON.parse(lines[1])).toMatchObject({ id: second.id, prompt: 'make it blue' })
    expect(first.id).not.toBe(second.id)
    expect(second.timestamp).toBeGreaterThanOrEqual(first.timestamp)

    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual([
      'a red fox',
      'make it blue',
    ])
  })

  it('never rewrites lines already written', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)
    const before = await fs.readFile(historyFile(id))

    await appendHistoryEntry(id, { ...imageTurn, status: 'failed', artifacts: [] })

    const after = await fs.readFile(historyFile(id))
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
    expect(after.length).toBeGreaterThan(before.length)
  })

  it('keeps the order of appends issued at the same time', async () => {
    const { id } = await createSession()
    await Promise.all(
      ['one', 'two', 'three', 'four'].map((prompt) =>
        appendHistoryEntry(id, { ...imageTurn, prompt }),
      ),
    )
    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual([
      'one',
      'two',
      'three',
      'four',
    ])
  })

  it('skips a torn line instead of losing the rest of the history', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)
    await fs.appendFile(historyFile(id), '{"id":"broken"')
    await fs.appendFile(historyFile(id), '\n')
    await appendHistoryEntry(id, { ...imageTurn, prompt: 'after the tear' })

    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual([
      'a red fox',
      'after the tear',
    ])
  })
})
