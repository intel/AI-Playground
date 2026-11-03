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

function ok<T extends object>(run: () => Promise<T>) {
  return async () => ({ success: true as const, ...(await run()) })
}

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-sessions-store-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  sessionModule.setSessionDeps({ isDemoMode: () => false })
  kernelBus.resetKernelBusForTest()
  vi.stubGlobal('window', {
    electronAPI: {
      onKernelEvent: kernelBus.onKernelEvent,
      getKernelSnapshot: async () => kernelBus.getKernelSnapshot(),
      sessions: {
        list: ok(async () => ({ sessions: await sessionModule.listSessions() })),
        create: ok(async () => ({ session: await sessionModule.createSession() })),
        open: (id: string) =>
          ok(async () => ({ session: await sessionModule.openSession(id), missingFiles: [] }))(),
        rename: (id: string, title: string) =>
          ok(async () => ({ session: await sessionModule.renameSession(id, title) }))(),
        delete: (id: string) => ok(async () => sessionModule.deleteSession(id).then(() => ({})))(),
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
})
