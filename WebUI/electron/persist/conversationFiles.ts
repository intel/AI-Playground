import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { getConversationsDemoDir, getConversationsDir } from './userDataPaths.ts'
import { completeOrphanedToolParts, sanitizeBulkyToolOutputs } from '@/lib/toolMessageSanitize'
import { restoreMissingHistory } from '@/lib/threadHistoryMerge'
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
import {
  ConversationIndexFileSchema,
  ConversationThreadFileSchema,
  type ConversationBootstrap,
  type ConversationIndexEntry,
  type ConversationIndexFile,
  type ConversationLegacyState,
  type ConversationSaveRequest,
  type ConversationThreadFile,
  type ConversationThreadMeta,
} from '@/types/conversationIpc'

/**
 * The kernel's one-writer conversation store (architecture-target §6.1,
 * step 8). Threads live as user-data files — `AI-Playground/conversations/`
 * (`<id>.json` plus `index.json`) — and everything else (renderer, Home Agent
 * surfaces) sends mutations here instead of touching the files.
 *
 * Correctness notes from §6.1, all implemented here: writes are atomic
 * (tmp + rename) so a crash cannot tear a thread; each thread carries
 * `schemaVersion` and is validated on read; the writer re-runs the
 * orphaned-tool-part repair and the bulky-output strip on every save, so an
 * interrupted turn can never be persisted into a brick; and two write chains
 * keep order — per-thread for the thread files, one global chain for the
 * index, always nested thread→index so the chains cannot deadlock. Demo mode
 * routes to a sibling directory that is wiped on exit.
 */

const appLogger = appLoggerInstance

export type ConversationFileDeps = {
  isDemoMode: () => boolean
}

let conversationFileDeps: ConversationFileDeps | null = null

export function setConversationFileDeps(deps: ConversationFileDeps): void {
  conversationFileDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()

function conversationsDir(): string {
  return conversationFileDeps?.isDemoMode() ? getConversationsDemoDir() : getConversationsDir()
}

const INDEX_CHAIN = 'index'
const INDEX_FILE = 'index.json'

function threadFile(id: string): string {
  assertSafeFileId(id, 'conversation')
  return path.join(conversationsDir(), `${id}.json`)
}

function indexFile(): string {
  return path.join(conversationsDir(), INDEX_FILE)
}

function threadDocFromRead(read: JsonRead): ConversationThreadFile | null {
  if (read.status !== 'ok') return null
  return parseThreadDoc(read.value)
}

function parseThreadDoc(raw: unknown): ConversationThreadFile | null {
  const parsed = ConversationThreadFileSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  appLogger.warn('conversation thread failed schema; treated as missing', 'conversations')
  return null
}

function emptyIndex(): ConversationIndexFile {
  return { schemaVersion: 1, lastMainKey: null, threads: [] }
}

async function rebuildIndexFromThreadFiles(): Promise<ConversationIndexFile> {
  const ids = await listFileIds(conversationsDir())
  const threads: ConversationIndexEntry[] = []
  for (const id of ids) {
    const doc = threadDocFromRead(await readJson(threadFile(id), 'conversations'))
    if (!doc) continue
    threads.push({
      id,
      title: titleFromMessages(doc.messages),
      presetName: doc.meta?.presetName || undefined,
      kind: doc.meta?.kind,
      updatedAt: doc.updatedAt,
    })
  }
  threads.sort((a, b) => a.updatedAt - b.updatedAt)
  const index: ConversationIndexFile = { schemaVersion: 1, lastMainKey: null, threads }
  await writeIndex(index)
  return index
}

function indexWithSafeIds(index: ConversationIndexFile): ConversationIndexFile {
  return {
    ...index,
    threads: index.threads.filter((thread) => isSafeFileId(thread.id)),
  }
}

/** Null only when nothing has ever been written (no index and no thread files). */
async function readIndex(): Promise<ConversationIndexFile | null> {
  const raw = await readJson(indexFile(), 'conversations')
  if (raw.status === 'missing') {
    const ids = await listFileIds(conversationsDir())
    if (ids.length === 0) return null
    appLogger.warn('conversation index missing; rebuilding from thread files', 'conversations')
    return rebuildIndexFromThreadFiles()
  }
  if (raw.status === 'ok') {
    const parsed = ConversationIndexFileSchema.safeParse(raw.value)
    if (parsed.success) return indexWithSafeIds(parsed.data)
  }
  appLogger.warn('conversation index failed schema; rebuilding from thread files', 'conversations')
  return rebuildIndexFromThreadFiles()
}

async function currentIndex(): Promise<ConversationIndexFile> {
  return (await readIndex()) ?? emptyIndex()
}

async function writeIndex(index: ConversationIndexFile): Promise<void> {
  await atomicWriteJson(indexFile(), index)
}

/**
 * The conversation title as the UI defines it: the first message's
 * `conversationTitle` metadata (set on rename, or the summary). The index
 * keeps it only as a listing convenience, so best-effort is enough.
 */
function titleFromMessages(messages: unknown[]): string | undefined {
  const first = messages[0] as { metadata?: { conversationTitle?: unknown } } | undefined
  const title = first?.metadata?.conversationTitle
  return typeof title === 'string' && title.length > 0 ? title : undefined
}

/**
 * Same repair-and-strip the renderer applies to its live copy. The one
 * writer re-runs them so a thread can never be persisted with an orphaned
 * tool call (which bricks the next generation) or an inline data URI.
 */
function sanitizeMessages(messages: unknown[]): unknown[] {
  return sanitizeBulkyToolOutputs(completeOrphanedToolParts(messages as never)) as unknown[]
}

type MessageWithId = { id: string }

type HydratedThread = {
  id: string
  meta: ConversationThreadMeta | null
  ragHashes: string[]
  messages: unknown[]
}

function hydratedThread(id: string, doc: ConversationThreadFile | null): HydratedThread {
  if (!doc) return { id, meta: null, ragHashes: [], messages: [] }
  return { id, meta: doc.meta, ragHashes: doc.ragHashes, messages: doc.messages }
}

async function threadsFromIndex(index: ConversationIndexFile): Promise<HydratedThread[]> {
  return Promise.all(
    index.threads
      .filter((entry) => isSafeFileId(entry.id))
      .map(async (entry) =>
        hydratedThread(
          entry.id,
          threadDocFromRead(await readJson(threadFile(entry.id), 'conversations')),
        ),
      ),
  )
}

async function bootstrapFromIndex(index: ConversationIndexFile): Promise<ConversationBootstrap> {
  return {
    status: 'ok' as const,
    lastMainKey: index.lastMainKey,
    threads: await threadsFromIndex(index),
  }
}

// ── Public API (IPC handlers) ─────────────────────────────────────────────────

export async function bootstrapConversations(): Promise<ConversationBootstrap> {
  return serialize(INDEX_CHAIN, async () => {
    const index = await readIndex()
    if (index === null) {
      // No index ever written: a fresh install (nothing to hydrate) or a
      // legacy boot — the renderer answers the latter with
      // `conversations:migrate`. An index with zero threads is NOT empty: it
      // was written, so the legacy upload already happened.
      return { status: 'empty' as const }
    }
    return bootstrapFromIndex(index)
  })
}

/**
 * One-shot legacy upload (§6.1: "localStorage migrates once, do not
 * dual-write"), as an idempotent merge: ids the files already hold are
 * skipped, and a pre-existing index is NOT a reason to refuse — a boot whose
 * bootstrap failed can have written an empty index while the legacy threads
 * stayed stranded in localStorage. Empty lists are fine — the point is that
 * an index now exists, so this never runs again.
 */
export async function migrateLegacyConversations(
  legacy: ConversationLegacyState,
): Promise<ConversationBootstrap> {
  return serialize(INDEX_CHAIN, async () => {
    const existing = await readIndex()
    const now = Date.now()
    const known = new Set(existing?.threads.map((entry) => entry.id) ?? [])
    const entries: ConversationIndexEntry[] = existing ? [...existing.threads] : []
    let wroteAny = false
    for (const id of Object.keys(legacy.conversationList)) {
      if (!isSafeFileId(id)) {
        appLogger.warn(`skipping unsafe legacy conversation id: ${id}`, 'conversations')
        continue
      }
      if (known.has(id)) continue
      const messages = sanitizeMessages(legacy.conversationList[id])
      const meta = legacy.conversationThreadMeta[id] ?? null
      const doc: ConversationThreadFile = {
        schemaVersion: 1,
        meta,
        ragHashes: legacy.conversationRagSelection[id] ?? [],
        messages,
        updatedAt: now,
      }
      await atomicWriteJson(threadFile(id), doc)
      entries.push({
        id,
        title: titleFromMessages(messages),
        presetName: meta?.presetName || undefined,
        kind: meta?.kind,
        updatedAt: now,
      })
      known.add(id)
      wroteAny = true
    }
    const index: ConversationIndexFile = {
      schemaVersion: 1,
      lastMainKey: existing?.lastMainKey ?? legacy.lastMainKey,
      threads: entries,
    }
    if (existing === null || wroteAny) await writeIndex(index)
    return bootstrapFromIndex(index)
  })
}

async function writeThread(request: ConversationSaveRequest): Promise<void> {
  const now = Date.now()
  const doc: ConversationThreadFile = {
    schemaVersion: 1,
    meta: request.meta,
    ragHashes: request.ragHashes,
    messages: sanitizeMessages(request.messages),
    updatedAt: now,
  }
  await atomicWriteJson(threadFile(request.id), doc)

  // Index updates run on the index chain (thread→index only, never the
  // reverse, so the chains cannot deadlock).
  await serialize(INDEX_CHAIN, async () => {
    const index = await currentIndex()
    const entry: ConversationIndexEntry = {
      id: request.id,
      title: titleFromMessages(doc.messages),
      presetName: request.meta?.presetName || undefined,
      kind: request.meta?.kind,
      updatedAt: now,
    }
    index.threads = [...index.threads.filter((thread) => thread.id !== request.id), entry]
    if (request.lastMainKey !== undefined) index.lastMainKey = request.lastMainKey
    await writeIndex(index)
  })
}

/** Upsert one thread (messages sanitized here) plus its index entry. */
export async function saveConversation(request: ConversationSaveRequest): Promise<void> {
  assertSafeFileId(request.id, 'conversation')
  return serialize(request.id, () => writeThread(request)).then(() => {
    emitStored('conversation', request.id)
  })
}

/**
 * The chat engine's write. Same upsert, except that a turn can only append to
 * the thread or truncate it from the end — so a list starting at a message the
 * file holds in the middle is a renderer that lost its history, and the prefix
 * it dropped is put back instead of overwriting the thread with it. Read and
 * write share the thread's chain, so a concurrent save cannot land between.
 */
export async function saveChatTurnConversation(request: ConversationSaveRequest): Promise<void> {
  assertSafeFileId(request.id, 'conversation')
  return serialize(request.id, async () => {
    const stored = threadDocFromRead(await readJson(threadFile(request.id), 'conversations'))
    await writeThread({
      ...request,
      messages: restoreMissingHistory(
        (stored?.messages ?? []) as MessageWithId[],
        request.messages as MessageWithId[],
      ),
    })
  }).then(() => {
    emitStored('conversation', request.id)
  })
}

export async function deleteConversation(id: string): Promise<void> {
  assertSafeFileId(id, 'conversation')
  return serialize(id, async () => {
    try {
      await fs.rm(threadFile(id))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        appLogger.warn(`conversation delete failed (${id}): ${String(error)}`, 'conversations')
      }
    }
    await serialize(INDEX_CHAIN, async () => {
      const index = await currentIndex()
      index.threads = index.threads.filter((thread) => thread.id !== id)
      await writeIndex(index)
    })
  })
}

export async function saveConversationLastMainKey(key: string | null): Promise<void> {
  return serialize(INDEX_CHAIN, async () => {
    const index = await currentIndex()
    index.lastMainKey = key
    await writeIndex(index)
  })
}

/** §6.1: demo threads are session-scoped; wipe on exit (and on boot, for a crash tail). */
export async function wipeDemoConversations(): Promise<void> {
  try {
    await fs.rm(getConversationsDemoDir(), { recursive: true, force: true })
  } catch (error) {
    appLogger.warn(`demo conversation wipe failed: ${String(error)}`, 'conversations')
  }
}

export function resetConversationFilesForTest(): void {
  conversationFileDeps = null
  clearChains()
}
