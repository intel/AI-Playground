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

  it('refuses an empty title', async () => {
    const session = await createSession()

    await expect(renameSession(session.id, '   ')).rejects.toThrow()
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
