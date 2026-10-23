import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { getAgentSessionsDemoDir, getAgentSessionsDir } from './userDataPaths.ts'
import { completeOrphanedToolParts, sanitizeBulkyToolOutputs } from '@/lib/toolMessageSanitize'
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
  AgentSessionFileSchema,
  AgentSessionIndexFileSchema,
  AgentSessionRecordSchema,
  type AgentSessionBootstrap,
  type AgentSessionFile,
  type AgentSessionIndexEntry,
  type AgentSessionIndexFile,
  type AgentSessionRecordWire,
  type LegacyAgentSessionState,
} from '@/types/agentSessionIpc'

/**
 * The kernel's one-writer agent-session store (architecture-target §6.1,
 * step 8): the renderer's session records — including the transcript each
 * one carries — live as user-data files (`AI-Playground/agent-sessions/`,
 * `<id>.json` plus `index.json`), and the agentMode store becomes a live
 * projection. Same correctness contract as conversationFiles.ts: atomic
 * writes, schema validation on read, sanitize on every write (an interrupted
 * turn must never persist an orphaned tool call, and no base64 payload rides
 * a transcript), per-id write chains with the index chain nested inside,
 * never the reverse. Pi's own session files are untouched — a record points
 * at its workspace, Pi keeps the model-side transcript.
 *
 * A corrupt session file hydrates as a placeholder (empty transcript, empty
 * workspace) so the Sessions panel keeps the id, matching conversations.
 * Resuming one does not adopt the empty workspace. The next snapshot of
 * that id overwrites the file.
 */

const appLogger = appLoggerInstance

const LOG_SCOPE = 'agent-sessions'

export type AgentSessionFileDeps = {
  isDemoMode: () => boolean
}

let agentSessionFileDeps: AgentSessionFileDeps | null = null

export function setAgentSessionFileDeps(deps: AgentSessionFileDeps): void {
  agentSessionFileDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()

const INDEX_CHAIN = 'index'
const INDEX_FILE = 'index.json'

function sessionsDir(): string {
  return agentSessionFileDeps?.isDemoMode() ? getAgentSessionsDemoDir() : getAgentSessionsDir()
}

function sessionFile(id: string): string {
  assertSafeFileId(id, 'agent session')
  return path.join(sessionsDir(), `${id}.json`)
}

function indexFile(): string {
  return path.join(sessionsDir(), INDEX_FILE)
}

function parseSessionDoc(read: JsonRead): AgentSessionFile | null {
  if (read.status !== 'ok') return null
  const parsed = AgentSessionFileSchema.safeParse(read.value)
  if (parsed.success) return parsed.data
  appLogger.warn('agent session file failed schema; treated as missing', LOG_SCOPE)
  return null
}

/**
 * Same repair-and-strip the renderer applies to its live copy (see
 * conversationFiles.ts): an orphaned tool call bricks the next generation,
 * and an inline data URI bloats every subsequent prompt.
 */
function sanitizeMessages(messages: unknown[]): unknown[] {
  return sanitizeBulkyToolOutputs(completeOrphanedToolParts(messages as never)) as unknown[]
}

function recordFromFile(doc: AgentSessionFile): AgentSessionRecordWire {
  const { schemaVersion: _version, ...record } = doc
  return record
}

function emptyIndex(): AgentSessionIndexFile {
  return { schemaVersion: 1, activeSessionId: null, sessions: [] }
}

async function writeIndex(index: AgentSessionIndexFile): Promise<void> {
  await atomicWriteJson(indexFile(), index)
}

async function rebuildIndexFromSessionFiles(): Promise<AgentSessionIndexFile> {
  const ids = await listFileIds(sessionsDir())
  const sessions: AgentSessionIndexEntry[] = []
  for (const id of ids) {
    const doc = parseSessionDoc(await readJson(sessionFile(id), LOG_SCOPE))
    if (!doc) continue
    sessions.push({ id, updatedAt: doc.updatedAt })
  }
  sessions.sort((a, b) => a.updatedAt - b.updatedAt)
  // A rebuilt index cannot know which session was open; that is the honest
  // state after losing the index, and the next open overwrites it.
  const index: AgentSessionIndexFile = { schemaVersion: 1, activeSessionId: null, sessions }
  await writeIndex(index)
  return index
}

function indexWithSafeIds(index: AgentSessionIndexFile): AgentSessionIndexFile {
  const active =
    index.activeSessionId && isSafeFileId(index.activeSessionId) ? index.activeSessionId : null
  return {
    ...index,
    activeSessionId: active,
    sessions: index.sessions.filter((entry) => isSafeFileId(entry.id)),
  }
}

/** Null only when nothing has ever been written (no index and no session files). */
async function readIndex(): Promise<AgentSessionIndexFile | null> {
  const raw = await readJson(indexFile(), LOG_SCOPE)
  if (raw.status === 'missing') {
    const ids = await listFileIds(sessionsDir())
    if (ids.length === 0) return null
    appLogger.warn('agent session index missing; rebuilding from session files', LOG_SCOPE)
    return rebuildIndexFromSessionFiles()
  }
  if (raw.status === 'ok') {
    const parsed = AgentSessionIndexFileSchema.safeParse(raw.value)
    if (parsed.success) return indexWithSafeIds(parsed.data)
  }
  appLogger.warn('agent session index failed schema; rebuilding from session files', LOG_SCOPE)
  return rebuildIndexFromSessionFiles()
}

async function currentIndex(): Promise<AgentSessionIndexFile> {
  return (await readIndex()) ?? emptyIndex()
}

const UNAVAILABLE_SESSION_TITLE = 'Unavailable session'

function placeholderRecord(entry: AgentSessionIndexEntry): AgentSessionRecordWire {
  return {
    id: entry.id,
    workspaceDir: '',
    title: UNAVAILABLE_SESSION_TITLE,
    createdAt: entry.updatedAt,
    updatedAt: entry.updatedAt,
    messages: [],
  }
}

function recordFromDocOrNull(read: JsonRead): AgentSessionRecordWire | null {
  const doc = parseSessionDoc(read)
  return doc ? recordFromFile(doc) : null
}

async function sessionsFromIndex(index: AgentSessionIndexFile): Promise<AgentSessionRecordWire[]> {
  return Promise.all(
    index.sessions
      .filter((entry) => isSafeFileId(entry.id))
      .map(async (entry) => {
        const record = recordFromDocOrNull(await readJson(sessionFile(entry.id), LOG_SCOPE))
        return record ?? placeholderRecord(entry)
      }),
  )
}

function bootstrapFromIndex(index: AgentSessionIndexFile): Promise<AgentSessionBootstrap> {
  return sessionsFromIndex(index).then((sessions) => ({
    status: 'ok' as const,
    activeSessionId: index.activeSessionId,
    sessions,
  }))
}

// ── Public API (IPC handlers) ─────────────────────────────────────────────────

export async function bootstrapAgentSessions(): Promise<AgentSessionBootstrap> {
  return serialize(INDEX_CHAIN, async () => {
    const index = await readIndex()
    if (index === null) {
      // No index ever written: a fresh install, or a legacy boot the renderer
      // answers with `agentMode:migrateSessions`. An index with zero sessions
      // is NOT empty — it was written, so the legacy upload already happened.
      return { status: 'empty' as const }
    }
    return bootstrapFromIndex(index)
  })
}

/**
 * One-shot legacy upload (§6.1: "localStorage migrates once, do not
 * dual-write"), as an idempotent merge: ids the files already hold are
 * skipped, and a pre-existing index is NOT a reason to refuse — a boot whose
 * bootstrap failed can have written an empty index while the legacy records
 * stayed stranded in localStorage. Records that fail their schema are skipped
 * with a warning — the persisted payload is best-effort input, not a trusted
 * file.
 */
export async function migrateLegacyAgentSessions(
  legacy: LegacyAgentSessionState,
): Promise<AgentSessionBootstrap> {
  return serialize(INDEX_CHAIN, async () => {
    const existing = await readIndex()
    const known = new Set(existing?.sessions.map((entry) => entry.id) ?? [])
    const entries: AgentSessionIndexEntry[] = existing ? [...existing.sessions] : []
    let wroteAny = false
    for (const [id, raw] of Object.entries(legacy.sessions)) {
      if (!isSafeFileId(id)) {
        appLogger.warn(`skipping unsafe legacy agent session id: ${id}`, LOG_SCOPE)
        continue
      }
      if (known.has(id)) continue
      const parsed = AgentSessionRecordSchema.safeParse(raw)
      if (!parsed.success) {
        appLogger.warn(`skipping legacy agent session that failed schema: ${id}`, LOG_SCOPE)
        continue
      }
      const doc: AgentSessionFile = {
        ...parsed.data,
        messages: sanitizeMessages(parsed.data.messages),
        schemaVersion: 1,
      }
      await atomicWriteJson(sessionFile(id), doc)
      entries.push({ id, updatedAt: doc.updatedAt })
      known.add(id)
      wroteAny = true
    }
    entries.sort((a, b) => a.updatedAt - b.updatedAt)
    const incomingActive =
      legacy.activeSessionId && isSafeFileId(legacy.activeSessionId) ? legacy.activeSessionId : null
    const index: AgentSessionIndexFile = {
      schemaVersion: 1,
      activeSessionId: existing?.activeSessionId ?? incomingActive,
      sessions: entries,
    }
    if (existing === null || wroteAny) await writeIndex(index)
    return bootstrapFromIndex(index)
  })
}

/** Upsert one session record (messages sanitized here) plus its index entry. */
export async function saveAgentSession(record: AgentSessionRecordWire): Promise<void> {
  assertSafeFileId(record.id, 'agent session')
  return serialize(record.id, async () => {
    const doc: AgentSessionFile = {
      ...record,
      messages: sanitizeMessages(record.messages),
      schemaVersion: 1,
    }
    await atomicWriteJson(sessionFile(record.id), doc)

    // Index updates run on the index chain (session→index only, never the
    // reverse, so the chains cannot deadlock).
    await serialize(INDEX_CHAIN, async () => {
      const index = await currentIndex()
      const entry: AgentSessionIndexEntry = { id: record.id, updatedAt: record.updatedAt }
      index.sessions = [...index.sessions.filter((entry) => entry.id !== record.id), entry]
      await writeIndex(index)
    })
  }).then(() => {
    emitStored('session', record.id)
  })
}

export async function saveAgentSessionActiveId(id: string | null): Promise<void> {
  if (id !== null) assertSafeFileId(id, 'agent session')
  return serialize(INDEX_CHAIN, async () => {
    const index = await currentIndex()
    index.activeSessionId = id
    await writeIndex(index)
  })
}

export async function deleteAgentSessionRecord(
  id: string,
): Promise<{ success: true } | { success: false; error: string }> {
  assertSafeFileId(id, 'agent session')
  try {
    await serialize(id, async () => {
      try {
        await fs.rm(sessionFile(id))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await serialize(INDEX_CHAIN, async () => {
        const index = await currentIndex()
        index.sessions = index.sessions.filter((entry) => entry.id !== id)
        await writeIndex(index)
      })
    })
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appLogger.warn(`agent session record delete failed (${id}): ${message}`, LOG_SCOPE)
    return { success: false, error: message }
  }
}

/** §6.1: demo sessions are session-scoped; wipe on exit (and on boot, for a crash tail). */
export async function wipeDemoAgentSessions(): Promise<void> {
  try {
    await fs.rm(getAgentSessionsDemoDir(), { recursive: true, force: true })
  } catch (error) {
    appLogger.warn(`demo agent session wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetAgentSessionFilesForTest(): void {
  agentSessionFileDeps = null
  clearChains()
}
