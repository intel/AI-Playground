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

vi.mock('../../kernel/kernelBus', () => ({ emitSessionChanged: vi.fn() }))

const {
  createSession,
  deleteSession,
  listSessions,
  onSessionDeleted,
  openSession,
  pinSession,
  renameSession,
  resetSessionsForTest,
  setSessionDeps,
  wipeDemoSessions,
} = await import('../../session/sessions')
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const { trackAgentTurnInSession } = await import('../../session/sessionAgentTurns')

function entry(prompt: string) {
  return {
    preset: 'Dummy Image (test)',
    kind: 'image' as const,
    prompt,
    status: 'completed' as const,
    artifacts: [],
  }
}

async function settleAgentTurn(sessionRef: string, prompt: string) {
  const turn = trackAgentTurnInSession({
    sessionRef,
    presetName: 'Agent',
    workspaceDir: path.join(dirs.real, sessionRef, 'files'),
    prompt,
  })
  await turn.settle({ sessionId: 'agent-session', turnId: 'turn-1', outcome: 'completed' })
}

async function listDir(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [])).sort()
}

let demo = false

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-sessions-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
})

beforeEach(() => {
  demo = false
  setSessionDeps({ isDemoMode: () => demo })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.demo, { recursive: true, force: true })
})

describe('Session module', () => {
  it('lays out a Session Folder on create', async () => {
    const session = await createSession()

    const folder = path.join(dirs.real, session.id)
    expect(await listDir(folder)).toEqual(['files', 'session-history.jsonl', 'session.json'])
    expect((await fs.stat(path.join(folder, 'files'))).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(folder, 'session-history.jsonl'), 'utf8')).toBe('')
    const file = JSON.parse(await fs.readFile(path.join(folder, 'session.json'), 'utf8'))
    expect(file).toMatchObject({
      schemaVersion: 1,
      id: session.id,
      title: '',
      renamed: false,
      timeline: [],
      settings: {},
      harnessSessions: {},
      updateCursors: {},
    })
  })

  it('lists Sessions newest first', async () => {
    const first = await createSession()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await createSession()

    expect((await listSessions()).map((session) => session.id)).toEqual([second.id, first.id])
  })

  it('lists nothing before any Session exists', async () => {
    expect(await listSessions()).toEqual([])
  })

  it('opens a Session with its timeline', async () => {
    const session = await createSession()

    expect(await openSession(session.id)).toMatchObject({
      id: session.id,
      title: '',
      timeline: [],
    })
  })

  it('renames a Session and remembers it was renamed', async () => {
    const session = await createSession()

    const renamed = await renameSession(session.id, '  Cat pictures  ')

    expect(renamed).toMatchObject({ id: session.id, title: 'Cat pictures', renamed: true })
    expect((await listSessions())[0]).toMatchObject({ title: 'Cat pictures', renamed: true })
  })

  it('leaves the last-used time alone on rename', async () => {
    const session = await createSession()
    await new Promise((resolve) => setTimeout(resolve, 5))

    const renamed = await renameSession(session.id, 'Cat pictures')

    expect(renamed.updatedAt).toBe(session.updatedAt)
    expect((await listSessions())[0].updatedAt).toBe(session.updatedAt)
  })

  it.each(['', '  \n '])('clears the Name on a blank rename (%j)', async (blank) => {
    const { id } = await createSession()
    await appendHistoryEntry(id, entry('a red fox\n  in   the snow'))
    await appendHistoryEntry(id, entry('a second prompt'))
    await renameSession(id, 'Foxes')

    const cleared = await renameSession(id, blank)

    expect(cleared).toMatchObject({ title: 'a red fox in the snow', renamed: false })
    expect((await listSessions())[0]).toMatchObject({ title: 'a red fox in the snow' })
  })

  it('shortens a long first prompt when a Name is cleared', async () => {
    const { id } = await createSession()
    const long = 'a very long prompt about a red fox jumping over a lazy dog in the moonlight'
    await appendHistoryEntry(id, entry(long))
    await renameSession(id, 'Foxes')

    expect((await renameSession(id, '')).title).toBe(
      'a very long prompt about a red fox jumping over a lazy dog…',
    )
  })

  it('falls back to the preset name when the first prompt is empty', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, { ...entry('   '), preset: 'Colorize' })
    await renameSession(id, 'Foxes')

    expect((await renameSession(id, '')).title).toBe('Colorize')
  })

  it('titles a cleared Session from the transcript of a first Speech-to-Text turn', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, {
      ...entry(''),
      kind: 'stt',
      preset: 'Speech to Text',
      response: 'Let us begin the meeting.',
    })
    await renameSession(id, 'Minutes')

    expect((await renameSession(id, '')).title).toBe('Let us begin the meeting.')
  })

  it('clears to an empty Title when the Session has no History Entry yet', async () => {
    const { id } = await createSession()
    await renameSession(id, 'Planned work')

    expect(await renameSession(id, ' ')).toMatchObject({ title: '', renamed: false })
  })

  it('keeps a Name given before the first turn', async () => {
    const { id } = await createSession()
    await renameSession(id, 'Planned work')

    await settleAgentTurn(id, 'build me a game')

    expect(await openSession(id)).toMatchObject({ title: 'Planned work', renamed: true })
  })

  it('titles a Session from its first agent turn, or the preset name when it had no prompt', async () => {
    const prompted = await createSession()
    const blank = await createSession()

    await settleAgentTurn(prompted.id, 'build me\na game')
    await settleAgentTurn(blank.id, '')

    expect((await openSession(prompted.id)).title).toBe('build me a game')
    expect((await openSession(blank.id)).title).toBe('Agent')
  })

  it('fails to rename a Session that does not exist', async () => {
    await expect(renameSession('session-missing', 'Foxes')).rejects.toThrow()
    await expect(renameSession('session-missing', '')).rejects.toThrow()
  })

  it('pins and unpins a Session, remembered across a re-list', async () => {
    const session = await createSession()
    expect((await listSessions())[0].pinned).toBe(false)

    expect(await pinSession(session.id, true)).toMatchObject({ id: session.id, pinned: true })
    expect((await listSessions())[0]).toMatchObject({ id: session.id, pinned: true })

    expect(await pinSession(session.id, false)).toMatchObject({ pinned: false })
    expect((await listSessions())[0].pinned).toBe(false)
  })

  it('leaves the last-used time alone on pin', async () => {
    const session = await createSession()
    await new Promise((resolve) => setTimeout(resolve, 5))

    await pinSession(session.id, true)

    expect((await listSessions())[0].updatedAt).toBe(session.updatedAt)
  })

  it('reads a Session file written before pinning existed as unpinned', async () => {
    const session = await createSession()
    const file = path.join(dirs.real, session.id, 'session.json')
    const { pinned: _pinned, ...legacy } = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify(legacy))

    expect((await listSessions())[0]).toMatchObject({ id: session.id, pinned: false })
  })

  it('fails to pin a Session that does not exist', async () => {
    await expect(pinSession('session-missing', true)).rejects.toThrow()
  })

  it('deletes the whole Session Folder, artifacts included', async () => {
    const session = await createSession()
    await fs.writeFile(path.join(dirs.real, session.id, 'files', 'cat.png'), 'png')

    await deleteSession(session.id)

    expect(await listDir(dirs.real)).toEqual([])
    expect(await listSessions()).toEqual([])
  })

  it('tells deletion listeners which Session went', async () => {
    const session = await createSession()
    const deleted: string[] = []
    onSessionDeleted((id) => {
      deleted.push(id)
    })

    await deleteSession(session.id)

    expect(deleted).toEqual([session.id])
  })

  it('rejects ids that could escape the Sessions root', async () => {
    await expect(openSession('../preferences')).rejects.toThrow()
    await expect(deleteSession('..')).rejects.toThrow()
  })

  it('fails to open a Session that does not exist', async () => {
    await expect(openSession('session-missing')).rejects.toThrow()
  })

  it('keeps a corrupt Session listed so it can be deleted', async () => {
    const session = await createSession()
    await fs.writeFile(path.join(dirs.real, session.id, 'session.json'), '{not json')

    const [row] = await listSessions()
    expect(row).toMatchObject({ id: session.id, unreadable: true, renamed: false })

    await deleteSession(session.id)
    expect(await listDir(dirs.real)).toEqual([])
  })

  it('ignores stray files beside the Session Folders', async () => {
    await createSession()
    await fs.writeFile(path.join(dirs.real, 'notes.txt'), 'hi')

    expect(await listSessions()).toHaveLength(1)
  })
})

describe('demo mode', () => {
  it('keeps demo Sessions in their own root', async () => {
    const real = await createSession()
    demo = true
    const demoSession = await createSession()

    expect(await listDir(dirs.demo)).toEqual([demoSession.id])
    expect((await listSessions()).map((session) => session.id)).toEqual([demoSession.id])
    demo = false
    expect((await listSessions()).map((session) => session.id)).toEqual([real.id])
  })

  it('wipes only the demo root', async () => {
    const real = await createSession()
    demo = true
    await createSession()

    await wipeDemoSessions()

    expect(await listSessions()).toEqual([])
    expect(await listDir(dirs.real)).toEqual([real.id])
  })
})
