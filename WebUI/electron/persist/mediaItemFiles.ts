import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { getMediaRecordsDemoDir, getMediaRecordsDir } from './userDataPaths.ts'
import {
  MediaItemFileSchema,
  MediaItemIndexFileSchema,
  type MediaItemIndexFile,
  type MediaItemsBootstrap,
} from '@/types/mediaItemIpc'
import type { MediaItem } from '@/types/mediaItem'
import {
  assertSafeFileId,
  atomicWriteJson,
  isSafeFileId,
  listFileIds,
  makeWriteChains,
  readJson,
  type JsonRead,
} from './fsJsonStore'
import { emitStored } from '../kernel/kernelBus'

/**
 * The kernel's one-writer store for generated-media gallery records
 * (architecture-target §6.1, step 8): the renderer's `generatedImages` array
 * lives as user-data files inside `media/records/` — one JSON per item plus
 * an ordered `index.json` — so the records sit beside the media files they
 * reference and a folder copy carries the whole gallery. The store is a live
 * projection; the correctness contract is conversationFiles.ts's: atomic
 * writes, schema validation on read, per-id write chains with the index
 * chain nested inside, never the reverse.
 *
 * Two rules are inherited from the localStorage serializer this replaces,
 * and are enforced here rather than trusted from the renderer:
 * - only terminal `done` items are durable (in-flight items never survive a
 *   reload, so they never reach a file), and
 * - no pixels in JSON: a `dynamicSettings` entry whose `current` holds an
 *   image/video data URI is a working copy (mask, outpaint composite) whose
 *   media live as files — it is scrubbed on write.
 *
 * A corrupt record is skipped rather than hydrated: the next save of that id
 * overwrites the file, and the item it describes would render as nothing.
 */

const appLogger = appLoggerInstance

const LOG_SCOPE = 'media-records'

export type MediaItemFileDeps = {
  isDemoMode: () => boolean
}

let mediaItemFileDeps: MediaItemFileDeps | null = null

export function setMediaItemFileDeps(deps: MediaItemFileDeps): void {
  mediaItemFileDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()

const INDEX_CHAIN = 'index'
const INDEX_FILE = 'index.json'

function recordsDir(): string {
  return mediaItemFileDeps?.isDemoMode() ? getMediaRecordsDemoDir() : getMediaRecordsDir()
}

function itemFile(id: string): string {
  assertSafeFileId(id, 'media item')
  return path.join(recordsDir(), `${id}.json`)
}

function indexFile(): string {
  return path.join(recordsDir(), INDEX_FILE)
}

function parseItemDoc(read: JsonRead): MediaItem | null {
  if (read.status !== 'ok') return null
  const parsed = MediaItemFileSchema.safeParse(read.value)
  if (parsed.success) {
    // The file→wire boundary: the lenient schema keeps freeform ComfyUI
    // `settings` / `dynamicSettings`, this cast narrows them back to MediaItem.
    return parsed.data as MediaItem
  }
  appLogger.warn('media item record failed schema; treated as missing', LOG_SCOPE)
  return null
}

function scrubDynamicSettingDataUris(item: MediaItem): MediaItem {
  if (!item.dynamicSettings) return item
  const dynamicSettings = item.dynamicSettings.map((entry) =>
    typeof entry.current === 'string' &&
    (entry.current.startsWith('data:image/') || entry.current.startsWith('data:video/'))
      ? { ...entry, current: '' }
      : entry,
  )
  return { ...item, dynamicSettings }
}

/** Schema + durability filter; the one entry point for anything headed to disk. */
function persistableItem(raw: unknown): MediaItem | null {
  const parsed = MediaItemFileSchema.safeParse(raw)
  if (!parsed.success) return null
  const item = parsed.data as MediaItem
  return item.state === 'done' ? item : null
}

function emptyIndex(): MediaItemIndexFile {
  return { schemaVersion: 1, items: [] }
}

async function writeIndex(index: MediaItemIndexFile): Promise<void> {
  await atomicWriteJson(indexFile(), index)
}

async function rebuildIndexFromItemFiles(): Promise<MediaItemIndexFile> {
  const ids = await listFileIds(recordsDir())
  const entries: { id: string; createdAt: number }[] = []
  for (const id of ids) {
    const doc = parseItemDoc(await readJson(itemFile(id), LOG_SCOPE))
    if (doc) entries.push({ id, createdAt: doc.createdAt ?? 0 })
  }
  // The array the store hydrates was createdAt-sorted before step 8; keep it.
  entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const index: MediaItemIndexFile = { schemaVersion: 1, items: entries.map((entry) => entry.id) }
  await writeIndex(index)
  return index
}

/** Null only when nothing has ever been written (no index and no record files). */
async function readIndex(): Promise<MediaItemIndexFile | null> {
  const raw = await readJson(indexFile(), LOG_SCOPE)
  if (raw.status === 'missing') {
    const ids = await listFileIds(recordsDir())
    if (ids.length === 0) return null
    appLogger.warn('media item index missing; rebuilding from record files', LOG_SCOPE)
    return rebuildIndexFromItemFiles()
  }
  if (raw.status === 'ok') {
    const parsed = MediaItemIndexFileSchema.safeParse(raw.value)
    if (parsed.success) {
      return { schemaVersion: 1, items: parsed.data.items.filter((id) => isSafeFileId(id)) }
    }
  }
  appLogger.warn('media item index failed schema; rebuilding from record files', LOG_SCOPE)
  return rebuildIndexFromItemFiles()
}

async function currentIndex() {
  return (await readIndex()) ?? emptyIndex()
}

async function itemsFromIndex(index: MediaItemIndexFile): Promise<MediaItem[]> {
  const items = await Promise.all(
    index.items.map(async (id) => parseItemDoc(await readJson(itemFile(id), LOG_SCOPE))),
  )
  return items.filter((item): item is MediaItem => item !== null)
}

// ── Public API (IPC handlers) ─────────────────────────────────────────────────

export async function bootstrapMediaItems(): Promise<MediaItemsBootstrap> {
  return serialize(INDEX_CHAIN, async () => {
    const index = await readIndex()
    // No index ever written: a fresh install, or a legacy boot the renderer
    // answers with `mediaItems:migrate`. An index with zero items is NOT
    // empty — it was written, so the legacy upload already happened.
    if (index === null) return { status: 'empty' as const }
    return { status: 'ok' as const, items: await itemsFromIndex(index) }
  })
}

/**
 * One-shot legacy upload (§6.1: "localStorage migrates once, do not
 * dual-write"), as an idempotent merge: ids the files already hold are
 * skipped, and a pre-existing index is NOT a reason to refuse — a boot whose
 * bootstrap failed can have written session items to files while the legacy
 * gallery stayed stranded in localStorage, and this is the rescue path that
 * merges the two. Items that fail their schema are skipped with a warning —
 * the persisted payload is best-effort input, not a trusted file.
 */
export async function migrateLegacyMediaItems(items: unknown[]): Promise<MediaItemsBootstrap> {
  return serialize(INDEX_CHAIN, async () => {
    const known = new Set((await currentIndex()).items)
    let wroteAny = false
    for (const raw of items) {
      const item = persistableItem(raw)
      if (!item) {
        appLogger.warn('skipping legacy media item that failed schema or was not done', LOG_SCOPE)
        continue
      }
      if (!isSafeFileId(item.id)) {
        appLogger.warn(`skipping unsafe media item id: ${item.id}`, LOG_SCOPE)
        continue
      }
      if (known.has(item.id)) continue
      await atomicWriteJson(itemFile(item.id), scrubDynamicSettingDataUris(item))
      known.add(item.id)
      wroteAny = true
    }
    // Rebuild so the merged order is chronological — the array the store
    // hydrates was createdAt-sorted before step 8, and an append-only index
    // would put rescued legacy items (the oldest) last.
    const index = wroteAny ? await rebuildIndexFromItemFiles() : await currentIndex()
    return { status: 'ok' as const, items: await itemsFromIndex(index) }
  })
}

/** Upsert a batch of items plus their index entries (id order = array order). */
export async function saveMediaItems(items: unknown[]): Promise<void> {
  const docs: MediaItem[] = []
  for (const raw of items) {
    const item = persistableItem(raw)
    if (!item) continue
    if (!isSafeFileId(item.id)) {
      appLogger.warn(`skipping unsafe media item id: ${item.id}`, LOG_SCOPE)
      continue
    }
    docs.push(scrubDynamicSettingDataUris(item))
  }
  if (docs.length === 0) return
  await Promise.all(
    docs.map((doc) =>
      serialize(doc.id, async () => {
        await atomicWriteJson(itemFile(doc.id), doc)
      }),
    ),
  )
  await serialize(INDEX_CHAIN, async () => {
    const index = await currentIndex()
    const known = new Set(index.items)
    for (const doc of docs) {
      if (!known.has(doc.id)) {
        index.items.push(doc.id)
        known.add(doc.id)
      }
    }
    await writeIndex(index)
  })
  emitStored('media')
}

export async function deleteMediaItemRecords(
  ids: string[],
): Promise<{ success: true } | { success: false; error: string }> {
  for (const id of ids) assertSafeFileId(id, 'media item')
  try {
    await Promise.all(
      ids.map((id) =>
        serialize(id, async () => {
          try {
            await fs.rm(itemFile(id))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }),
      ),
    )
    await serialize(INDEX_CHAIN, async () => {
      const index = await currentIndex()
      const removed = new Set(ids)
      index.items = index.items.filter((id) => !removed.has(id))
      await writeIndex(index)
    })
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appLogger.warn(`media item record delete failed: ${message}`, LOG_SCOPE)
    return { success: false, error: message }
  }
}

/** §6.1: demo gallery records are session-scoped; wipe on exit (and boot, for a crash tail). */
export async function wipeDemoMediaRecords(): Promise<void> {
  try {
    await fs.rm(getMediaRecordsDemoDir(), { recursive: true, force: true })
  } catch (error) {
    appLogger.warn(`demo media record wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetMediaItemFilesForTest(): void {
  mediaItemFileDeps = null
  clearChains()
}
