import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The Sessions store driven against the real Session module in a temp dir, so
// what the panel shows is what is on disk.

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/assets/js/toast', () => ({
  show: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))

const sessionModule = await import('../../session/sessions')
const kernelBus = await import('../../kernel/kernelBus')
const { recordMediaTurn } = await import('../../session/sessionMediaTurn')
const { useSessions } = await import('@/assets/js/store/sessions')
const ledger = await import('../../session/sessionTurns')
const { buildSessionsRegistry } = await import('../../kernel/registries/sessions')
type SessionsDeps = import('../../kernel/registries/sessions').SessionsDeps

const registry = buildSessionsRegistry(sessionModule as unknown as SessionsDeps)
const noEvent = {} as never

function ok<T extends object>(run: () => Promise<T>) {
  return async () => ({ success: true as const, ...(await run()) })
}

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-sessions-store-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  sessionModule.setSessionDeps({ isDemoMode: () => false })
  kernelBus.resetKernelBusForTest()
  ledger.resetSessionTurnsForTest()
  vi.stubGlobal('window', {
    electronAPI: {
      onKernelEvent: kernelBus.onKernelEvent,
      getKernelSnapshot: async () => kernelBus.getKernelSnapshot(),
      sessions: {
        list: ok(async () => ({
          sessions: await sessionModule.listSessions(),
          groups: await sessionModule.listSessionGroups(),
          pinnedShowMore: await sessionModule.readPinnedShowMore(),
        })),
        create: ok(async () => ({ session: await sessionModule.createSession() })),
        open: (id: string) =>
          ok(async () => ({ session: await sessionModule.openSession(id), missingFiles: [] }))(),
        rename: (id: string, title: string) =>
          ok(async () => ({ session: await sessionModule.renameSession(id, title) }))(),
        delete: (id: string) => ok(async () => sessionModule.deleteSession(id).then(() => ({})))(),
        createGroup: (id: string, name: string) =>
          registry['sessions:createGroup'](noEvent, id, name),
        renameGroup: (groupId: string, name: string) =>
          registry['sessions:renameGroup'](noEvent, groupId, name),
        setGroupExpanded: (groupId: string, expanded: boolean) =>
          registry['sessions:setGroupExpanded'](noEvent, groupId, expanded),
      },
    },
  })
  setActivePinia(createPinia())
})

afterEach(async () => {
  vi.unstubAllGlobals()
  sessionModule.resetSessionsForTest()
  await fs.rm(path.dirname(dirs.real), { recursive: true, force: true })
})

describe('Sessions store', () => {
  it('opens a fresh Session on first boot', async () => {
    const store = useSessions()

    await store.init()

    const onDisk = await sessionModule.listSessions()
    expect(onDisk).toHaveLength(1)
    expect(store.openSessionId).toBe(onDisk[0].id)
  })

  it('reopens the most recent Session on a later boot', async () => {
    await sessionModule.createSession()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newest = await sessionModule.createSession()
    const store = useSessions()

    await store.init()

    expect(store.openSessionId).toBe(newest.id)
    expect(store.orderedSessions).toHaveLength(2)
  })

  it('"+" always creates and opens another Session', async () => {
    const store = useSessions()
    await store.init()
    const first = store.openSessionId

    await store.create()

    expect(store.openSessionId).not.toBe(first)
    expect(await sessionModule.listSessions()).toHaveLength(2)
  })

  it('shows a renamed title', async () => {
    const store = useSessions()
    await store.init()

    await store.rename(store.openSessionId!, 'Holiday cards')

    expect(store.openSession?.title).toBe('Holiday cards')
  })

  it('sees a Session pinned or unpinned in main through the Session-changed push', async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!

    await sessionModule.pinSession(id, true)
    await vi.waitFor(() => expect(store.openSession?.pinned).toBe(true))

    await sessionModule.pinSession(id, false)
    await vi.waitFor(() => expect(store.openSession?.pinned).toBe(false))
  })

  it('sees a Session renamed or cleared in main through the Session-changed push', async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!

    await sessionModule.renameSession(id, 'Holiday cards')
    await vi.waitFor(() => expect(store.openSession?.title).toBe('Holiday cards'))

    await sessionModule.renameSession(id, '')
    await vi.waitFor(() => expect(store.openSession).toMatchObject({ title: '', renamed: false }))
  })

  it('moves to another Session when the open one is deleted', async () => {
    const store = useSessions()
    await store.init()
    const kept = store.openSessionId!
    const doomed = (await store.create())!

    await store.remove(doomed)

    expect(store.openSessionId).toBe(kept)
    expect((await sessionModule.listSessions()).map((session) => session.id)).toEqual([kept])
  })

  it('starts a new Session when the last one is deleted', async () => {
    const store = useSessions()
    await store.init()
    const only = store.openSessionId!

    await store.remove(only)

    expect(store.openSessionId).not.toBe(only)
    expect(store.orderedSessions.map((session) => session.id)).toEqual([store.openSessionId])
  })

  it('shows a media turn that settled into the open Session', async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!

    await recordMediaTurn({
      sessionId: id,
      runId: 'run-1',
      mode: 'imageGen',
      preset: 'Dummy Image (test)',
      prompt: 'a red fox',
      status: 'failed',
      items: [],
      localPathOf: () => null,
    })

    await vi.waitFor(() => expect(store.openTimeline).toHaveLength(2))
    expect(store.sessions[id]).toMatchObject({
      title: 'a red fox',
      presetsUsed: ['Dummy Image (test)'],
    })
  })

  it("knows each Session's turn in flight, and marks one that ended out of sight as unseen", async () => {
    const store = useSessions()
    await store.init()
    const background = store.openSessionId!
    await store.create()
    const open = store.openSessionId!

    ledger.claimSessionTurn(background, { turnId: 'a', kind: 'agent' })
    ledger.claimSessionTurn(open, { turnId: 'b', kind: 'media' })
    await vi.waitFor(() => expect(store.openTurn?.kind).toBe('media'))
    expect(store.turns[background]?.kind).toBe('agent')

    ledger.releaseSessionTurn(background, 'a')
    ledger.releaseSessionTurn(open, 'b')
    await vi.waitFor(() => expect(store.openTurn).toBeNull())
    expect(store.unseen).toEqual({ [background]: true })

    await store.open(background)
    expect(store.unseen).toEqual({})
  })

  it('learns the turns already in flight when it connects', async () => {
    const session = await sessionModule.createSession()
    ledger.claimSessionTurn(session.id, { turnId: 'a', kind: 'chat' })
    const store = useSessions()

    await store.init()

    await vi.waitFor(() => expect(store.openTurn?.kind).toBe('chat'))
  })

  it('sees Groups renamed, collapsed, deleted and Pinned "show more" through the Groups push', async () => {
    const store = useSessions()
    await store.init()
    const { group } = await sessionModule.createSessionGroup(store.openSessionId!, 'Lisbon')
    await vi.waitFor(() => expect(store.groups).toEqual([group]))

    await sessionModule.renameSessionGroup(group.id, 'Porto')
    await sessionModule.setSessionGroupExpanded(group.id, false)
    await vi.waitFor(() =>
      expect(store.groups).toEqual([{ ...group, name: 'Porto', expanded: false }]),
    )

    await sessionModule.setPinnedShowMore(true)
    await sessionModule.deleteSessionGroup(group.id)
    await vi.waitFor(() => expect(store.groups).toEqual([]))
    expect(store.pinnedShowMore).toBe(true)
  })

  it("refuses a Group name main finds taken, though this store's list had not seen it", async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!
    const other = await sessionModule.createSession()
    await sessionModule.createSessionGroup(other.id, 'Lisbon')
    store.groups = []

    expect(await store.createGroup(id, 'lisbon')).toMatchObject({ problem: 'taken' })
    expect(store.sessions[id]?.groupId).toBeUndefined()
  })

  it('refuses renaming a Group to a name main finds taken', async () => {
    const store = useSessions()
    await store.init()
    const { group } = await sessionModule.createSessionGroup(store.openSessionId!, 'Lisbon')
    const other = await sessionModule.createSession()
    await sessionModule.createSessionGroup(other.id, 'Porto')

    expect(await store.renameGroup(group.id, 'PORTO')).toMatchObject({ problem: 'taken' })
    expect(await store.renameGroup(group.id, 'Faro')).toBeNull()
  })

  it('expands a collapsed Group when one of its Sessions is opened, and lets it be collapsed again', async () => {
    const store = useSessions()
    await store.init()
    const inside = store.openSessionId!
    const { group } = await sessionModule.createSessionGroup(inside, 'Lisbon')
    await sessionModule.setSessionGroupExpanded(group.id, false)
    await store.create()
    await vi.waitFor(() => expect(store.groups[0]?.expanded).toBe(false))

    await store.open(inside)
    await vi.waitFor(() => expect(store.groups[0]?.expanded).toBe(true))

    await store.setGroupExpanded(group.id, false)
    expect(store.groups[0]?.expanded).toBe(false)
    expect((await sessionModule.listSessionGroups())[0]?.expanded).toBe(false)
  })

  it('keeps a collapsed Group collapsed when its Session is reopened on boot', async () => {
    const first = await sessionModule.createSession()
    const { group } = await sessionModule.createSessionGroup(first.id, 'Lisbon')
    await sessionModule.setSessionGroupExpanded(group.id, false)

    const store = useSessions()
    await store.init()
    expect(store.openSessionId).toBe(first.id)
    expect(store.groups[0]?.expanded).toBe(false)
  })
})
