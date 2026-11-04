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

vi.mock('../../kernel/kernelBus', () => ({
  emitSessionChanged: vi.fn(),
  emitSessionGroupsChanged: vi.fn(),
}))

const {
  createSession,
  createSessionGroup,
  deleteSession,
  deleteSessionGroup,
  listSessionGroups,
  listSessions,
  moveSessionToGroup,
  onSessionDeleted,
  openSession,
  pinSession,
  readPinnedShowMore,
  renameSession,
  renameSessionGroup,
  resetSessionsForTest,
  setPinnedShowMore,
  setSessionGroupExpanded,
  setSessionDeps,
  wipeDemoSessions,
} = await import('../../session/sessions')
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const { emitSessionGroupsChanged } = await import('../../kernel/kernelBus')
const { groupNameProblemOf } = await import('@/lib/sessionGroupName')
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

async function sessionFile(id: string, root = dirs.real) {
  return JSON.parse(await fs.readFile(path.join(root, id, 'session.json'), 'utf8'))
}

function groupsFile(root = dirs.real) {
  return path.join(root, 'session-groups.json')
}

describe('Session Groups', () => {
  it('creates a Group with a Session in it, both surviving a re-list', async () => {
    const session = await createSession()

    const created = await createSessionGroup(session.id, '  Lisbon trip  ')

    expect(created.session).toMatchObject({ id: session.id, groupId: created.group.id })
    expect(created.group).toMatchObject({ name: 'Lisbon trip', expanded: true })
    expect(await listSessionGroups()).toEqual([created.group])
    expect((await listSessions())[0]).toMatchObject({ id: session.id, groupId: created.group.id })
  })

  it('moves a Session between Groups and out of one, remembered across a re-list', async () => {
    const a = await createSession()
    const b = await createSession()
    const { group: lisbon } = await createSessionGroup(a.id, 'Lisbon')
    const { group: porto } = await createSessionGroup(b.id, 'Porto')

    expect(await moveSessionToGroup(a.id, porto.id)).toMatchObject({ groupId: porto.id })
    expect((await listSessions()).find((s) => s.id === a.id)?.groupId).toBe(porto.id)

    const removed = await moveSessionToGroup(a.id, null)
    expect(removed.groupId).toBeUndefined()
    expect((await listSessions()).find((s) => s.id === a.id)?.groupId).toBeUndefined()
    expect((await sessionFile(a.id)).groupId).toBeUndefined()
    expect((await listSessionGroups()).map((g) => g.id)).toEqual([lisbon.id, porto.id])
  })

  it('leaves the last-used time alone when moving a Session', async () => {
    const session = await createSession()
    const other = await createSession()
    await new Promise((resolve) => setTimeout(resolve, 5))

    const { group } = await createSessionGroup(session.id, 'Lisbon')
    await createSessionGroup(other.id, 'Porto')
    await moveSessionToGroup(other.id, group.id)
    await moveSessionToGroup(session.id, null)

    const listed = await listSessions()
    expect(listed.find((s) => s.id === session.id)?.updatedAt).toBe(session.updatedAt)
    expect(listed.find((s) => s.id === other.id)?.updatedAt).toBe(other.updatedAt)
  })

  it.each(['', '   '])('refuses a blank Group name (%j)', async (blank) => {
    const session = await createSession()

    await expect(createSessionGroup(session.id, blank)).rejects.toThrow()
    expect(await listSessionGroups()).toEqual([])
    expect((await listSessions())[0].groupId).toBeUndefined()
  })

  it('refuses a Group name longer than a Session Name may be', async () => {
    const session = await createSession()

    await expect(createSessionGroup(session.id, 'x'.repeat(501))).rejects.toThrow()
    await expect(createSessionGroup(session.id, 'x'.repeat(500))).resolves.toBeTruthy()
  })

  it('refuses a Group name already taken in another case', async () => {
    const a = await createSession()
    const b = await createSession()
    await createSessionGroup(a.id, 'Lisbon')

    const refusal = await createSessionGroup(b.id, ' LISBON ').catch((e: unknown) => e)
    expect(groupNameProblemOf(refusal)).toBe('taken')
    expect(await listSessionGroups()).toHaveLength(1)
    expect((await listSessions()).find((s) => s.id === b.id)?.groupId).toBeUndefined()
  })

  it('reads a Session file written before Groups existed as ungrouped', async () => {
    const session = await createSession()

    expect((await sessionFile(session.id)).groupId).toBeUndefined()
    expect((await listSessions())[0].groupId).toBeUndefined()
  })

  it('keeps a groupId naming a missing Group on the file', async () => {
    const session = await createSession()
    const { group } = await createSessionGroup(session.id, 'Lisbon')
    await fs.writeFile(groupsFile(), JSON.stringify({ schemaVersion: 1, groups: [] }))

    expect(await listSessionGroups()).toEqual([])
    expect((await listSessions())[0].groupId).toBe(group.id)
    expect((await sessionFile(session.id)).groupId).toBe(group.id)
  })

  it('lists no Groups from an unreadable Groups file and touches no groupId', async () => {
    const a = await createSession()
    const b = await createSession()
    const { group } = await createSessionGroup(a.id, 'Lisbon')
    await fs.writeFile(groupsFile(), '{not json')

    expect(await listSessionGroups()).toEqual([])
    await expect(createSessionGroup(b.id, 'Porto')).rejects.toThrow()
    await expect(moveSessionToGroup(b.id, group.id)).rejects.toThrow()
    expect(await fs.readFile(groupsFile(), 'utf8')).toBe('{not json')
    expect((await sessionFile(a.id)).groupId).toBe(group.id)
    expect((await sessionFile(b.id)).groupId).toBeUndefined()
  })

  it('finds its Groups again once the Groups file reads again', async () => {
    const session = await createSession()
    const { group } = await createSessionGroup(session.id, 'Lisbon')
    const saved = await fs.readFile(groupsFile(), 'utf8')
    await fs.writeFile(groupsFile(), '{not json')
    await listSessions()

    await fs.writeFile(groupsFile(), saved)

    expect(await listSessionGroups()).toEqual([group])
    expect((await listSessions())[0].groupId).toBe(group.id)
  })

  it('fails on a missing Session or Group', async () => {
    const session = await createSession()
    await createSessionGroup(session.id, 'Lisbon')

    await expect(createSessionGroup('session-missing', 'Porto')).rejects.toThrow()
    await expect(moveSessionToGroup('session-missing', null)).rejects.toThrow()
    await expect(moveSessionToGroup(session.id, 'group-missing')).rejects.toThrow()
    expect((await listSessionGroups()).map((g) => g.name)).toEqual(['Lisbon'])
  })

  it('remembers whether a Group is expanded across a re-list', async () => {
    const session = await createSession()
    const { group } = await createSessionGroup(session.id, 'Lisbon')

    expect(await setSessionGroupExpanded(group.id, false)).toMatchObject({ expanded: false })
    expect(await listSessionGroups()).toEqual([{ ...group, expanded: false }])
    await setSessionGroupExpanded(group.id, true)
    expect(await listSessionGroups()).toEqual([group])
  })

  it('renames a Group, remembered across a re-list', async () => {
    const session = await createSession()
    const { group } = await createSessionGroup(session.id, 'Lisbon')

    expect(await renameSessionGroup(group.id, '  Porto  ')).toEqual({ ...group, name: 'Porto' })
    expect(await listSessionGroups()).toEqual([{ ...group, name: 'Porto' }])
    expect((await listSessions())[0].groupId).toBe(group.id)
  })

  it('refuses renaming a Group to a blank, too long or taken name', async () => {
    const a = await createSession()
    const b = await createSession()
    const { group } = await createSessionGroup(a.id, 'Lisbon')
    await createSessionGroup(b.id, 'Porto')

    const refusal = (name: string) => renameSessionGroup(group.id, name).catch((e: unknown) => e)
    expect(groupNameProblemOf(await refusal('   '))).toBe('blank')
    expect(groupNameProblemOf(await refusal('x'.repeat(501)))).toBe('tooLong')
    expect(groupNameProblemOf(await refusal('porto'))).toBe('taken')
    expect((await listSessionGroups()).map((g) => g.name)).toEqual(['Lisbon', 'Porto'])
  })

  it('allows renaming a Group to its own name in another case', async () => {
    const session = await createSession()
    const { group } = await createSessionGroup(session.id, 'Lisbon')

    await expect(renameSessionGroup(group.id, 'LISBON')).resolves.toMatchObject({ name: 'LISBON' })
  })

  it('deletes a Group, keeping its Sessions and taking them out of it', async () => {
    const a = await createSession()
    const b = await createSession()
    const other = await createSession()
    const { group } = await createSessionGroup(a.id, 'Lisbon')
    await moveSessionToGroup(b.id, group.id)
    const { group: porto } = await createSessionGroup(other.id, 'Porto')
    await pinSession(b.id, true)

    await deleteSessionGroup(group.id)

    expect(await listSessionGroups()).toEqual([porto])
    const listed = await listSessions()
    expect(listed.map((s) => s.id).sort()).toEqual([a.id, b.id, other.id].sort())
    expect(listed.find((s) => s.id === a.id)?.groupId).toBeUndefined()
    expect(listed.find((s) => s.id === b.id)).toMatchObject({ pinned: true })
    expect(listed.find((s) => s.id === b.id)?.groupId).toBeUndefined()
    expect(listed.find((s) => s.id === other.id)?.groupId).toBe(porto.id)
    expect((await sessionFile(a.id)).groupId).toBeUndefined()
    expect(listed.find((s) => s.id === a.id)?.updatedAt).toBe(a.updatedAt)
  })

  it('creates a new Session already in a Group', async () => {
    const first = await createSession()
    const { group } = await createSessionGroup(first.id, 'Lisbon')

    const created = await createSession(group.id)

    expect(created.groupId).toBe(group.id)
    expect((await sessionFile(created.id)).groupId).toBe(group.id)
  })

  it('fails Group operations on a missing Group', async () => {
    await expect(renameSessionGroup('group-missing', 'Lisbon')).rejects.toThrow()
    await expect(deleteSessionGroup('group-missing')).rejects.toThrow()
    await expect(setSessionGroupExpanded('group-missing', false)).rejects.toThrow()
    await expect(createSession('group-missing')).rejects.toThrow()
    expect(await listSessions()).toEqual([])
  })

  it('leaves an unreadable Groups file alone when renaming, deleting or expanding', async () => {
    const session = await createSession()
    const { group } = await createSessionGroup(session.id, 'Lisbon')
    await fs.writeFile(groupsFile(), '{not json')

    await expect(renameSessionGroup(group.id, 'Porto')).rejects.toThrow()
    await expect(deleteSessionGroup(group.id)).rejects.toThrow()
    await expect(setSessionGroupExpanded(group.id, false)).rejects.toThrow()
    expect(await fs.readFile(groupsFile(), 'utf8')).toBe('{not json')
    expect((await sessionFile(session.id)).groupId).toBe(group.id)
  })

  it('deletes a grouped Session like any other', async () => {
    const session = await createSession()
    const { group } = await createSessionGroup(session.id, 'Lisbon')

    await deleteSession(session.id)

    expect(await listSessions()).toEqual([])
    expect(await listSessionGroups()).toEqual([group])
  })
})

describe('Session Groups push', () => {
  const pushes = () => vi.mocked(emitSessionGroupsChanged).mock.calls.map(([state]) => state)

  beforeEach(() => vi.mocked(emitSessionGroupsChanged).mockClear())

  it('pushes the whole Groups state after every Groups-file write', async () => {
    const session = await createSession()
    const { group } = await createSessionGroup(session.id, 'Lisbon')
    await renameSessionGroup(group.id, 'Porto')
    await setSessionGroupExpanded(group.id, false)
    await setPinnedShowMore(true)
    await deleteSessionGroup(group.id)

    const renamed = { ...group, name: 'Porto' }
    expect(pushes()).toEqual([
      { groups: [group], pinnedShowMore: false },
      { groups: [renamed], pinnedShowMore: false },
      { groups: [{ ...renamed, expanded: false }], pinnedShowMore: false },
      { groups: [{ ...renamed, expanded: false }], pinnedShowMore: true },
      { groups: [], pinnedShowMore: true },
    ])
  })

  it('pushes nothing when a write is refused', async () => {
    const session = await createSession()
    const { group } = await createSessionGroup(session.id, 'Lisbon')
    vi.mocked(emitSessionGroupsChanged).mockClear()

    await expect(renameSessionGroup(group.id, '  ')).rejects.toThrow()
    await expect(deleteSessionGroup('group-missing')).rejects.toThrow()

    expect(pushes()).toEqual([])
  })
})

describe('Pinned "show more"', () => {
  it('starts off and survives a re-read once shown', async () => {
    expect(await readPinnedShowMore()).toBe(false)

    await setPinnedShowMore(true)
    expect(await readPinnedShowMore()).toBe(true)
    await setPinnedShowMore(false)
    expect(await readPinnedShowMore()).toBe(false)
  })

  it('is kept when Groups change', async () => {
    const session = await createSession()
    await setPinnedShowMore(true)

    const { group } = await createSessionGroup(session.id, 'Lisbon')

    expect(await readPinnedShowMore()).toBe(true)
    expect(await listSessionGroups()).toEqual([group])
  })

  it('reads a Groups file written before it existed as off', async () => {
    await fs.mkdir(dirs.real, { recursive: true })
    await fs.writeFile(groupsFile(), JSON.stringify({ schemaVersion: 1, groups: [] }))

    expect(await readPinnedShowMore()).toBe(false)
  })

  it('reads off from an unreadable Groups file and refuses to overwrite it', async () => {
    await fs.mkdir(dirs.real, { recursive: true })
    await fs.writeFile(groupsFile(), '{not json')

    expect(await readPinnedShowMore()).toBe(false)
    await expect(setPinnedShowMore(true)).rejects.toThrow()
    expect(await fs.readFile(groupsFile(), 'utf8')).toBe('{not json')
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

  it('keeps demo Groups in their own root', async () => {
    const real = await createSession()
    const { group } = await createSessionGroup(real.id, 'Lisbon')
    demo = true
    const demoSession = await createSession()

    expect(await listSessionGroups()).toEqual([])
    await createSessionGroup(demoSession.id, 'Lisbon')
    expect(await fs.readFile(groupsFile(dirs.demo), 'utf8')).toContain('Lisbon')
    demo = false
    expect(await listSessionGroups()).toEqual([group])
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
