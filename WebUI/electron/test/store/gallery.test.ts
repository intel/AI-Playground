import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The gallery and the open Session's timeline driven against the real Session
// module in a temp dir, so a deletion is checked against what is on disk.

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
const artifactModule = await import('../../session/sessionArtifacts')
const kernelBus = await import('../../kernel/kernelBus')
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const { useSessions } = await import('@/assets/js/store/sessions')
const { useGallery } = await import('@/assets/js/store/gallery')

function ok<T extends object>(run: () => Promise<T>) {
  return async () => ({ success: true as const, ...(await run()) })
}

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-gallery-store-'))
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
          ok(async () => ({
            session: await sessionModule.openSession(id),
            missingFiles: await artifactModule.missingArtifactUrls(id),
          }))(),
        delete: (id: string) => ok(async () => sessionModule.deleteSession(id).then(() => ({})))(),
        listArtifacts: ok(async () => ({ artifacts: await artifactModule.listAllArtifacts() })),
        deleteArtifact: (id: string, relativePath: string) =>
          ok(async () => artifactModule.deleteArtifact(id, relativePath).then(() => ({})))(),
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

async function sessionWith(name: string): Promise<string> {
  const { id } = await sessionModule.createSession()
  const filesDir = sessionModule.sessionPaths(id).filesDir
  await fs.mkdir(filesDir, { recursive: true })
  await fs.writeFile(path.join(filesDir, name), 'bytes')
  await appendHistoryEntry(id, {
    preset: 'Dummy Image (test)',
    kind: 'image',
    prompt: name,
    status: 'completed',
    artifacts: [{ path: `files/${name}`, mediaType: 'image' }],
  })
  return id
}

describe('Gallery store', () => {
  it('shows the artifacts of every Session', async () => {
    const first = await sessionWith('fox.png')
    const second = await sessionWith('owl.png')
    const gallery = useGallery()

    await gallery.refresh()

    expect(gallery.artifacts.map((artifact) => artifact.sessionId).sort()).toEqual(
      [first, second].sort(),
    )
  })

  it('deletes an artifact out of the gallery and marks its card in the open Session', async () => {
    const id = await sessionWith('fox.png')
    const sessions = useSessions()
    const gallery = useGallery()
    await sessions.init()
    await gallery.refresh()
    const [fox] = gallery.artifacts

    await gallery.remove(fox)

    expect(gallery.artifacts).toEqual([])
    expect(sessions.isFileDeleted(fox.url)).toBe(true)
    await sessions.open(id)
    expect(sessions.isFileDeleted(fox.url)).toBe(true)
  })

  it('deletes the file behind a timeline card by its URL', async () => {
    const id = await sessionWith('fox.png')
    const sessions = useSessions()
    await sessions.init()
    const url = `aipg-media://sessions/${id}/files/fox.png`

    await useGallery().removeByUrl(url)

    const file = path.join(sessionModule.sessionPaths(id).filesDir, 'fox.png')
    await expect(fs.access(file)).rejects.toThrow()
    expect(sessions.isFileDeleted(url)).toBe(true)
  })

  it('opens the Session an artifact came from', async () => {
    const older = await sessionWith('fox.png')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await sessionWith('owl.png')
    const sessions = useSessions()
    const gallery = useGallery()
    await sessions.init()
    await gallery.refresh()

    await gallery.openSessionOf(gallery.artifacts.find((a) => a.sessionId === older)!)

    expect(sessions.openSessionId).toBe(older)
  })
})
