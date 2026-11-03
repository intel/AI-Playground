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

const { createSession, deleteSession, renameSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const { deleteArtifact, listAllArtifacts, missingArtifactUrls } =
  await import('../../session/sessionArtifacts')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-artifacts-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
})

let demo = false

beforeEach(() => {
  demo = false
  setSessionDeps({ isDemoMode: () => demo })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.demo, { recursive: true, force: true })
})

async function sessionWithArtifacts(title: string, names: string[], prompt = 'a red fox') {
  const { id } = await createSession()
  await renameSession(id, title)
  const filesDir = path.join(demo ? dirs.demo : dirs.real, id, 'files')
  await fs.mkdir(filesDir, { recursive: true })
  for (const name of names) await fs.writeFile(path.join(filesDir, name), `bytes of ${name}`)
  await appendHistoryEntry(id, {
    preset: 'Dummy Image (test)',
    kind: 'image',
    prompt,
    status: 'completed',
    artifacts: names.map((name) => ({ path: `files/${name}`, mediaType: 'image' as const })),
  })
  return id
}

describe('the gallery across Sessions', () => {
  it('lists the artifacts of every Session, newest first', async () => {
    const older = await sessionWithArtifacts('Foxes', ['fox.png'])
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newer = await sessionWithArtifacts('Owls', ['owl-1.png', 'owl-2.png'], 'an owl')

    const artifacts = await listAllArtifacts()

    expect(artifacts.map((artifact) => [artifact.sessionId, artifact.path])).toEqual([
      [newer, 'files/owl-1.png'],
      [newer, 'files/owl-2.png'],
      [older, 'files/fox.png'],
    ])
    expect(artifacts[2]).toEqual(
      expect.objectContaining({
        sessionTitle: 'Foxes',
        preset: 'Dummy Image (test)',
        kind: 'image',
        prompt: 'a red fox',
        mediaType: 'image',
        url: `aipg-media://sessions/${older}/files/fox.png`,
      }),
    )
  })

  it('leaves out an artifact whose file is gone', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png', 'gone.png'])
    await fs.rm(path.join(dirs.real, id, 'files', 'gone.png'))

    expect((await listAllArtifacts()).map((artifact) => artifact.path)).toEqual(['files/fox.png'])
  })

  it('drops a deleted Session’s artifacts', async () => {
    const kept = await sessionWithArtifacts('Foxes', ['fox.png'])
    const removed = await sessionWithArtifacts('Owls', ['owl.png'])

    await deleteSession(removed)

    expect((await listAllArtifacts()).map((artifact) => artifact.sessionId)).toEqual([kept])
  })

  it('lists only the demo root in demo mode', async () => {
    await sessionWithArtifacts('Real', ['fox.png'])
    demo = true
    const demoId = await sessionWithArtifacts('Demo', ['owl.png'])

    expect((await listAllArtifacts()).map((artifact) => artifact.sessionId)).toEqual([demoId])
  })
})

describe('deleting an artifact', () => {
  it('removes the file and leaves the History Entries byte for byte', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png', 'owl.png'])
    const historyFile = path.join(dirs.real, id, 'session-history.jsonl')
    const before = await fs.readFile(historyFile)

    await deleteArtifact(id, 'files/fox.png')

    expect(await fs.readdir(path.join(dirs.real, id, 'files'))).toEqual(['owl.png'])
    expect(await fs.readFile(historyFile)).toEqual(before)
    expect((await listAllArtifacts()).map((artifact) => artifact.path)).toEqual(['files/owl.png'])
  })

  it('reports the deleted file as missing for the timeline card', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png', 'owl.png'])

    await deleteArtifact(id, 'files/fox.png')

    expect(await missingArtifactUrls(id)).toEqual([`aipg-media://sessions/${id}/files/fox.png`])
  })

  it('is a no-op for a file already gone', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png'])
    await deleteArtifact(id, 'files/fox.png')

    await expect(deleteArtifact(id, 'files/fox.png')).resolves.toBeUndefined()
  })

  it.each(['../session.json', 'session.json', 'files/../session-history.jsonl', 'files'])(
    'refuses a path outside the Session’s files (%s)',
    async (relativePath) => {
      const id = await sessionWithArtifacts('Foxes', ['fox.png'])

      await expect(deleteArtifact(id, relativePath)).rejects.toThrow()

      const folder = (await fs.readdir(path.join(dirs.real, id))).sort()
      expect(folder).toEqual(['files', 'session-history.jsonl', 'session.json'])
      expect(await fs.readdir(path.join(dirs.real, id, 'files'))).toEqual(['fox.png'])
    },
  )
})
