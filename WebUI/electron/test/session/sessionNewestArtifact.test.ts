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
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const { newestArtifact } = await import('../../session/sessionArtifacts')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-artifacts-'))
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

type Artifact = { path: string; mediaType: 'image' | 'video' | 'audio' | 'model3d' }

async function settle(
  sessionId: string,
  turn: { preset: string; kind: 'image' | 'edit' | 'video' | 'tts' | 'stt' | 'agent' | 'chat' },
  artifacts: Artifact[],
): Promise<string> {
  for (const artifact of artifacts) {
    const file = path.join(dirs.real, sessionId, artifact.path)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'x')
  }
  const entry = await appendHistoryEntry(sessionId, {
    ...turn,
    prompt: 'p',
    status: 'completed',
    artifacts,
  })
  return entry.id
}

describe('newest matching artifact', () => {
  it('is null for a Session without matching artifacts', async () => {
    const { id } = await createSession()
    expect(await newestArtifact(id, 'image')).toBeNull()
    await settle(id, { preset: 'Text To Speech', kind: 'tts' }, [
      { path: 'files/hello.wav', mediaType: 'audio' },
    ])
    expect(await newestArtifact(id, 'image')).toBeNull()
  })

  it('picks by media type: the newest image for images, the newest audio for audio', async () => {
    const { id } = await createSession()
    const imageEntry = await settle(id, { preset: 'Dummy Image (test)', kind: 'image' }, [
      { path: 'files/fox.png', mediaType: 'image' },
    ])
    const audioEntry = await settle(id, { preset: 'Text To Speech', kind: 'tts' }, [
      { path: 'files/hello.wav', mediaType: 'audio' },
    ])
    await settle(id, { preset: 'Dummy Video (test)', kind: 'video' }, [
      { path: 'files/clip.mp4', mediaType: 'video' },
    ])

    expect(await newestArtifact(id, 'image')).toEqual({
      entryId: imageEntry,
      path: 'files/fox.png',
      url: `aipg-media://sessions/${id}/files/fox.png`,
    })
    expect(await newestArtifact(id, 'audio')).toMatchObject({
      entryId: audioEntry,
      path: 'files/hello.wav',
    })
  })

  it('counts images from every preset, agent-made ones included', async () => {
    const { id } = await createSession()
    await settle(id, { preset: 'Dummy Image (test)', kind: 'image' }, [
      { path: 'files/fox.png', mediaType: 'image' },
    ])
    const agentEntry = await settle(id, { preset: 'Game Agent', kind: 'agent' }, [
      { path: 'files/cover.png', mediaType: 'image' },
    ])
    await settle(id, { preset: 'Basic Chat', kind: 'chat' }, [])

    expect(await newestArtifact(id, 'image')).toMatchObject({
      entryId: agentEntry,
      path: 'files/cover.png',
    })
  })

  it('takes the last image of a batch', async () => {
    const { id } = await createSession()
    await settle(id, { preset: 'Dummy Image (test)', kind: 'image' }, [
      { path: 'files/one.png', mediaType: 'image' },
      { path: 'files/two.png', mediaType: 'image' },
    ])
    expect(await newestArtifact(id, 'image')).toMatchObject({ path: 'files/two.png' })
  })

  it('skips an artifact whose file was deleted', async () => {
    const { id } = await createSession()
    const older = await settle(id, { preset: 'Dummy Image (test)', kind: 'image' }, [
      { path: 'files/kept.png', mediaType: 'image' },
    ])
    await settle(id, { preset: 'Dummy Edit (test)', kind: 'edit' }, [
      { path: 'files/gone.png', mediaType: 'image' },
    ])
    await fs.rm(path.join(dirs.real, id, 'files/gone.png'))

    expect(await newestArtifact(id, 'image')).toMatchObject({
      entryId: older,
      path: 'files/kept.png',
    })
  })

  it('never resolves a path outside the Session Folder', async () => {
    const { id } = await createSession()
    await fs.writeFile(path.join(dirs.real, 'outside.png'), 'x')
    await appendHistoryEntry(id, {
      preset: 'Dummy Image (test)',
      kind: 'image',
      prompt: 'p',
      status: 'completed',
      artifacts: [{ path: '../outside.png', mediaType: 'image' }],
    })
    expect(await newestArtifact(id, 'image')).toBeNull()
  })
})
