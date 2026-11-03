import { randomUUID } from 'node:crypto'
import {
  assertSessionId,
  createSessionFolder,
  listSessionFolders,
  readSessionFile,
  removeSessionFolder,
  resetSessionFilesForTest,
  serializeSession,
  sessionFolderPaths,
  setSessionFileDeps,
  wipeDemoSessionFolders,
  writeSessionFile,
  type SessionFileDeps,
  type SessionFolderPaths,
} from '../persist/sessionFiles'
import {
  SessionTitleSchema,
  type SessionDocument,
  type SessionFile,
  type SessionSummary,
} from '@/types/sessionIpc'

/**
 * The Session module (ADR-0003): the one owner of every Session Folder. The
 * renderer reaches it over the `sessions:` IPC rows; turn engines call it
 * in-process. Later concerns (History Entries, Session Update, Session
 * Settings) build on `mutateSession` and `sessionPaths` in their own files.
 */

export type SessionDeletedListener = (id: string) => void | Promise<void>

const deletedListeners = new Set<SessionDeletedListener>()

const UNAVAILABLE_TITLE = 'Unavailable session'

export function setSessionDeps(deps: SessionFileDeps): void {
  setSessionFileDeps(deps)
}

export function sessionPaths(id: string): SessionFolderPaths {
  return sessionFolderPaths(id)
}

function summaryOf(file: SessionFile): SessionSummary {
  const { id, title, renamed, createdAt, updatedAt, presetsUsed } = file
  return { id, title, renamed, createdAt, updatedAt, presetsUsed }
}

async function requireSessionFile(id: string): Promise<SessionFile> {
  const read = await readSessionFile(id)
  if (read.status === 'ok') return read.file
  throw new Error(
    read.status === 'missing' ? `no such session: ${id}` : `session unreadable: ${id}`,
  )
}

export async function createSession(): Promise<SessionSummary> {
  const now = Date.now()
  const file: SessionFile = {
    schemaVersion: 1,
    id: `session-${randomUUID()}`,
    title: '',
    renamed: false,
    createdAt: now,
    updatedAt: now,
    presetsUsed: [],
    timeline: [],
    settings: {},
    harnessSessions: {},
    updateCursors: {},
  }
  await serializeSession(file.id, () => createSessionFolder(file))
  return summaryOf(file)
}

/** Newest first. A Session whose `session.json` is unreadable stays listed so it can be deleted. */
export async function listSessions(): Promise<SessionSummary[]> {
  const folders = await listSessionFolders()
  const rows = await Promise.all(
    folders.map(async ({ id, mtimeMs }): Promise<SessionSummary | null> => {
      const read = await readSessionFile(id)
      if (read.status === 'ok') return summaryOf(read.file)
      if (read.status === 'missing') return null
      const time = Math.floor(mtimeMs)
      return {
        id,
        title: UNAVAILABLE_TITLE,
        renamed: true,
        createdAt: time,
        updatedAt: time,
        presetsUsed: [],
      }
    }),
  )
  return rows
    .filter((row): row is SessionSummary => row !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
}

export async function openSession(id: string): Promise<SessionDocument> {
  const file = await requireSessionFile(id)
  return { ...summaryOf(file), timeline: file.timeline }
}

/** Read-modify-write of one `session.json` on that Session's write chain. */
export async function mutateSession(
  id: string,
  mutate: (file: SessionFile) => SessionFile,
): Promise<SessionFile> {
  assertSessionId(id)
  return serializeSession(id, async () => {
    const next = mutate(await requireSessionFile(id))
    await writeSessionFile(next)
    return next
  })
}

export async function renameSession(id: string, title: string): Promise<SessionSummary> {
  const trimmed = SessionTitleSchema.parse(title)
  const file = await mutateSession(id, (current) => ({
    ...current,
    title: trimmed,
    renamed: true,
    updatedAt: Math.max(Date.now(), current.updatedAt),
  }))
  return summaryOf(file)
}

/** Removes the Session Folder, then lets owners of Session-bound data (Tasks, Harness Sessions) clean up. */
export async function deleteSession(id: string): Promise<void> {
  assertSessionId(id)
  await serializeSession(id, () => removeSessionFolder(id))
  for (const listener of deletedListeners) await listener(id)
}

export function onSessionDeleted(listener: SessionDeletedListener): () => void {
  deletedListeners.add(listener)
  return () => deletedListeners.delete(listener)
}

export async function wipeDemoSessions(): Promise<void> {
  await wipeDemoSessionFolders()
}

export function resetSessionsForTest(): void {
  deletedListeners.clear()
  resetSessionFilesForTest()
}
