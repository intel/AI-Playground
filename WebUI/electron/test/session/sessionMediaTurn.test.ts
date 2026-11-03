import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '@/types/mediaItem'

const dirs = vi.hoisted(() => ({ real: '', demo: '', media: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { createSession, openSession, renameSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { recordMediaTurn } = await import('../../session/sessionMediaTurn')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-media-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.media = path.join(root, 'media')
})

beforeEach(async () => {
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(dirs.media, { recursive: true })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.media, { recursive: true, force: true })
})

const localPathOf = (url: string): string | null =>
  url.startsWith('aipg-media://media/')
    ? path.join(dirs.media, decodeURIComponent(url.slice('aipg-media://media/'.length)))
    : null

async function comfyOutput(name: string): Promise<string> {
  await fs.writeFile(path.join(dirs.media, name), `bytes of ${name}`)
  return `aipg-media://media/${name}`
}

function doneImage(imageUrl: string): MediaItem {
  return {
    id: `item-${imageUrl}`,
    mode: 'imageGen',
    state: 'done',
    type: 'image',
    imageUrl,
    settings: { preset: 'Dummy Image (test)', prompt: 'a red fox' },
    dynamicSettings: [],
    createdAt: 1,
  } as MediaItem
}

function turn(sessionId: string, items: MediaItem[], overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    runId: 'run-1',
    mode: 'imageGen' as const,
    preset: 'Dummy Image (test)',
    variant: 'Fast',
    prompt: 'a red fox',
    status: 'completed' as const,
    items,
    localPathOf,
    ...overrides,
  }
}

describe('a media turn in a Session', () => {
  it('moves the output into the Session Folder and points the item at it', async () => {
    const { id } = await createSession()
    const url = await comfyOutput('ComfyUI_00001_.png')

    const [item] = await recordMediaTurn(turn(id, [doneImage(url)]))

    expect(await fs.readdir(path.join(dirs.real, id, 'files'))).toEqual(['ComfyUI_00001_.png'])
    expect(await fs.readdir(dirs.media)).toEqual([])
    expect(item.type === 'image' && item.imageUrl).toBe(
      `aipg-media://sessions/${id}/files/ComfyUI_00001_.png`,
    )
  })

  it('moves a video and only a real thumbnail file with it', async () => {
    const { id } = await createSession()
    const video = {
      ...doneImage('unused'),
      mode: 'video',
      type: 'video',
      videoUrl: await comfyOutput('clip.mp4'),
      thumbnailUrl: 'aipg-media://media/',
    } as unknown as MediaItem

    const [item] = await recordMediaTurn(turn(id, [video], { mode: 'video' }))

    expect(item.type === 'video' && item.videoUrl).toBe(
      `aipg-media://sessions/${id}/files/clip.mp4`,
    )
    expect((await fs.stat(dirs.media)).isDirectory()).toBe(true)
    expect(await fs.readdir(path.join(dirs.real, id, 'files'))).toEqual(['clip.mp4'])
  })

  it('appends one History Entry describing the run', async () => {
    const { id } = await createSession()
    const url = await comfyOutput('fox.png')

    await recordMediaTurn(turn(id, [doneImage(url)]))

    expect(await readHistoryEntries(id)).toEqual([
      expect.objectContaining({
        preset: 'Dummy Image (test)',
        variant: 'Fast',
        kind: 'image',
        prompt: 'a red fox',
        status: 'completed',
        artifacts: [{ path: 'files/fox.png', mediaType: 'image' }],
      }),
    ])
  })

  it('records a failed run with no artifacts', async () => {
    const { id } = await createSession()

    await recordMediaTurn(
      turn(id, [], { mode: 'imageEdit', status: 'failed', error: 'Generation failed' }),
    )

    expect(await readHistoryEntries(id)).toEqual([
      expect.objectContaining({ kind: 'edit', status: 'failed', artifacts: [] }),
    ])
  })

  it('never overwrites an artifact already in the Session Folder', async () => {
    const { id } = await createSession()
    await recordMediaTurn(turn(id, [doneImage(await comfyOutput('out.png'))]))
    await recordMediaTurn(turn(id, [doneImage(await comfyOutput('out.png'))], { runId: 'run-2' }))

    const files = (await fs.readdir(path.join(dirs.real, id, 'files'))).sort()
    expect(files).toHaveLength(2)
    const entries = await readHistoryEntries(id)
    expect(new Set(entries.map((entry) => entry.artifacts[0].path)).size).toBe(2)
  })

  it('adds the prompt and the result card to the display timeline', async () => {
    const { id } = await createSession()
    await recordMediaTurn(turn(id, [doneImage(await comfyOutput('fox.png'))]))
    await recordMediaTurn(
      turn(id, [], { runId: 'run-2', mode: 'imageEdit', prompt: 'blue', status: 'cancelled' }),
    )

    const { timeline } = await openSession(id)
    expect(timeline).toEqual([
      expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: 'a red fox' }] }),
      expect.objectContaining({
        role: 'assistant',
        parts: [
          {
            type: 'data-media',
            data: expect.objectContaining({
              runId: 'run-1',
              mode: 'imageGen',
              status: 'completed',
              items: [
                expect.objectContaining({
                  imageUrl: `aipg-media://sessions/${id}/files/fox.png`,
                }),
              ],
            }),
          },
        ],
      }),
      expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: 'blue' }] }),
      expect.objectContaining({
        role: 'assistant',
        parts: [
          {
            type: 'data-media',
            data: expect.objectContaining({ mode: 'imageEdit', status: 'cancelled', items: [] }),
          },
        ],
      }),
    ])
  })

  it('titles the Session with its first prompt, truncated', async () => {
    const { id } = await createSession()
    const long = 'a very long prompt about a red fox jumping over a lazy dog in the moonlight'
    await recordMediaTurn(turn(id, [], { prompt: long, status: 'failed' }))
    await recordMediaTurn(turn(id, [], { prompt: 'second prompt', status: 'failed' }))

    const session = await openSession(id)
    expect(session.title.length).toBeLessThanOrEqual(60)
    expect(session.title.startsWith('a very long prompt about a red fox')).toBe(true)
    expect(session.title.endsWith('…')).toBe(true)
    expect(session.presetsUsed).toEqual(['Dummy Image (test)'])
  })

  it('keeps a title the user chose', async () => {
    const { id } = await createSession()
    await renameSession(id, 'My fox')
    await recordMediaTurn(turn(id, [], { status: 'failed' }))

    expect((await openSession(id)).title).toBe('My fox')
  })
})
