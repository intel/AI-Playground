import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The kernel's one-writer store for generated-media gallery records
// (architecture-target §6.1, step 8). Driven against real files in a temp
// dir: bootstrap, the idempotent legacy merge-upload, save-time durability
// rules (done-only, no data URIs), deletes, demo routing, and the
// corrupt-index rebuild.

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getMediaRecordsDir: () => dirs.real,
  getMediaRecordsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { appLoggerInstance } = await import('../../observability/logger')
const {
  bootstrapMediaItems,
  deleteMediaItemRecords,
  migrateLegacyMediaItems,
  resetMediaItemFilesForTest,
  saveMediaItems,
  setMediaItemFileDeps,
  wipeDemoMediaRecords,
} = await import('../../persist/mediaItemFiles')

const imageItem = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'image',
  state: 'done',
  mode: 'imageGen',
  imageUrl: 'aipg-media://media/ComfyUI_00001_.png',
  settings: { preset: 'Pro Image', seed: 1 },
  createdAt: 1,
  ...overrides,
})

const videoItem = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'video',
  state: 'done',
  mode: 'video',
  videoUrl: 'aipg-media://media/ComfyUI_00001_.mp4',
  settings: {},
  createdAt: 2,
  ...overrides,
})

/** A mask working copy riding a dynamic setting — pixels must not reach a file. */
const dataUriDynamicSetting = () => [
  { id: 'mask', label: 'Inpaint mask', current: 'data:image/png;base64,AAAA', type: 'IMAGE' },
]

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function listDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => [])
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-media-records-'))
  dirs.real = path.join(root, 'real')
  dirs.demo = path.join(root, 'demo')
})

let demoMode = false

beforeEach(async () => {
  resetMediaItemFilesForTest()
  demoMode = false
  setMediaItemFileDeps({ isDemoMode: () => demoMode })
  vi.mocked(appLoggerInstance.warn).mockClear()
})

afterEach(async () => {
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.demo, { recursive: true, force: true })
  resetMediaItemFilesForTest()
})

describe('bootstrapMediaItems', () => {
  it('reports empty on a fresh install', async () => {
    await expect(bootstrapMediaItems()).resolves.toEqual({ status: 'empty' })
  })

  it('hydrates the items in index order after a migration', async () => {
    await migrateLegacyMediaItems([
      imageItem('newer', { createdAt: 20 }),
      imageItem('older', { createdAt: 10 }),
    ])
    const boot = await bootstrapMediaItems()
    if (boot.status !== 'ok') throw new Error('expected ok')
    expect(boot.items.map((item) => item.id)).toEqual(['older', 'newer'])
  })

  it('rebuilds a corrupt index from the record files, in createdAt order', async () => {
    await saveMediaItems([
      imageItem('newer', { createdAt: 20 }),
      imageItem('older', { createdAt: 10 }),
    ])
    await fs.writeFile(path.join(dirs.real, 'index.json'), '{ not json', 'utf8')

    const boot = await bootstrapMediaItems()
    if (boot.status !== 'ok') throw new Error('expected ok')
    expect(boot.items.map((item) => item.id)).toEqual(['older', 'newer'])
  })

  it('skips a record file that fails its schema instead of hydrating it', async () => {
    await saveMediaItems([imageItem('item-1')])
    await fs.writeFile(
      path.join(dirs.real, 'item-1.json'),
      JSON.stringify({ id: 'item-1', type: 'image' }),
      'utf8',
    )

    const boot = await bootstrapMediaItems()
    if (boot.status !== 'ok') throw new Error('expected ok')
    expect(boot.items).toEqual([])
  })
})

describe('migrateLegacyMediaItems', () => {
  it('uploads the legacy gallery once', async () => {
    const boot = await migrateLegacyMediaItems([
      imageItem('item-1'),
      videoItem('item-2'),
      { id: 'not-done', type: 'image', state: 'queued', mode: 'imageGen', imageUrl: '' },
      { no: 'shape at all' },
    ])
    if (boot.status !== 'ok') throw new Error('expected ok')
    expect(boot.items.map((item) => item.id)).toEqual(['item-1', 'item-2'])
    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect(index.items).toEqual(['item-1', 'item-2'])
  })

  it('merges into an existing index instead of refusing (the stranded-gallery rescue)', async () => {
    await saveMediaItems([imageItem('session-item', { createdAt: 30 })])
    const boot = await migrateLegacyMediaItems([imageItem('legacy-item', { createdAt: 10 })])
    if (boot.status !== 'ok') throw new Error('expected ok')
    expect(boot.items.map((item) => item.id)).toEqual(['legacy-item', 'session-item'])
  })

  it('is idempotent: an id the files already hold is not written twice', async () => {
    await migrateLegacyMediaItems([imageItem('item-1', { settings: { seed: 1 } })])
    const boot = await migrateLegacyMediaItems([imageItem('item-1', { settings: { seed: 99 } })])
    if (boot.status !== 'ok') throw new Error('expected ok')
    const doc = await readJson(path.join(dirs.real, 'item-1.json'))
    expect((doc.settings as { seed: number }).seed).toBe(1)
  })

  it('skips unsafe legacy ids and still writes the safe items in the same batch', async () => {
    const boot = await migrateLegacyMediaItems([
      imageItem('item-1'),
      imageItem('../escape'),
      imageItem('index'),
    ])
    if (boot.status !== 'ok') throw new Error('expected ok')
    expect(boot.items.map((item) => item.id)).toEqual(['item-1'])
    expect((await listDir(dirs.real)).sort()).toEqual(['index.json', 'item-1.json'])
  })
})

describe('saveMediaItems', () => {
  it('writes each item and appends new ids to the index', async () => {
    await saveMediaItems([imageItem('item-1')])
    await saveMediaItems([imageItem('item-1'), imageItem('item-2')])

    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect(index).toMatchObject({ schemaVersion: 1, items: ['item-1', 'item-2'] })
    const doc = await readJson(path.join(dirs.real, 'item-1.json'))
    expect(doc).toMatchObject({ id: 'item-1', state: 'done', type: 'image' })
  })

  it('does not write an empty index when every item is in-flight', async () => {
    await saveMediaItems([imageItem('item-queued', { state: 'queued' })])
    expect(await listDir(dirs.real)).toEqual([])
  })

  it('drops items that are not done — in-flight items never reach a file', async () => {
    await saveMediaItems([
      imageItem('item-1'),
      imageItem('item-queued', { state: 'queued' }),
      imageItem('item-generating', { state: 'generating' }),
    ])
    expect((await listDir(dirs.real)).sort()).toEqual(['index.json', 'item-1.json'])
    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect(index.items).toEqual(['item-1'])
  })

  it('scrubs data URIs out of dynamic settings before writing', async () => {
    await saveMediaItems([imageItem('item-1', { dynamicSettings: dataUriDynamicSetting() })])
    const doc = await readJson(path.join(dirs.real, 'item-1.json'))
    const dynamicSettings = doc.dynamicSettings as { current: string }[]
    expect(dynamicSettings[0].current).toBe('')
  })

  it('routes to the demo directory and the wipe removes it', async () => {
    demoMode = true
    await saveMediaItems([imageItem('item-1')])
    expect((await listDir(dirs.demo)).sort()).toEqual(['index.json', 'item-1.json'])
    expect(await listDir(dirs.real)).toEqual([])

    await wipeDemoMediaRecords()
    expect(await listDir(dirs.demo)).toEqual([])
  })

  it('orders concurrent saves through the index without losing ids', async () => {
    await Promise.all([
      saveMediaItems([imageItem('item-1')]),
      saveMediaItems([imageItem('item-2')]),
    ])
    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect((index.items as string[]).sort()).toEqual(['item-1', 'item-2'])
  })

  it('skips an id that would overwrite index.json, without writing an empty index', async () => {
    await expect(saveMediaItems([imageItem('index')])).resolves.toBeUndefined()
    expect(await listDir(dirs.real)).toEqual([])
  })

  it('skips path-shaped ids and still writes the rest of the batch', async () => {
    await saveMediaItems([imageItem('../x'), imageItem('item-1')])
    expect((await listDir(dirs.real)).sort()).toEqual(['index.json', 'item-1.json'])
  })
})

describe('deleteMediaItemRecords', () => {
  it('removes the files and the index entries', async () => {
    await saveMediaItems([imageItem('item-1'), imageItem('item-2')])

    await expect(deleteMediaItemRecords(['item-1'])).resolves.toEqual({ success: true })
    expect((await listDir(dirs.real)).sort()).toEqual(['index.json', 'item-2.json'])
    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect(index.items).toEqual(['item-2'])
  })

  it('treats a missing file as already deleted (ENOENT is fine)', async () => {
    await expect(deleteMediaItemRecords(['never-existed'])).resolves.toEqual({ success: true })
  })

  it('reports failure when a file cannot be removed', async () => {
    await saveMediaItems([imageItem('item-1')])
    // Make the record's path a directory, so `rm` without `recursive` fails.
    await fs.rm(path.join(dirs.real, 'item-1.json'))
    await fs.mkdir(path.join(dirs.real, 'item-1.json'), { recursive: true })
    const result = await deleteMediaItemRecords(['item-1'])
    expect(result.success).toBe(false)
    expect('error' in result && result.error).toBeTruthy()
  })

  it('rejects an unsafe id without touching the index', async () => {
    await saveMediaItems([imageItem('item-1')])
    await expect(deleteMediaItemRecords(['../escape'])).rejects.toThrow(/invalid media item id/)
    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect(index.items).toEqual(['item-1'])
  })
})
