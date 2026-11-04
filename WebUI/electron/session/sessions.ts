import { randomUUID } from 'node:crypto'
import { emitSessionChanged } from '../kernel/kernelBus'
import {
  assertSessionId,
  createSessionFolder,
  listSessionFolders,
  readSessionFile,
  removeSessionFolder,
  resetSessionFilesForTest,
  serializeSession,
  sessionFolderPaths,
  sessionsRoot,
  setSessionFileDeps,
  wipeDemoSessionFolders,
  writeSessionFile,
  type SessionFileDeps,
  type SessionFolderPaths,
} from '../persist/sessionFiles'
import { readHistoryEntries } from './sessionHistory'
import { autoTitle } from './sessionTitle'
import {
  SessionTitleSchema,
  type SessionDocument,
  type SessionFile,
  type SessionSummary,
} from '@/types/sessionIpc'

// The Session module (ADR-0003), sole owner of every Session Folder.

/** `deleted` is the Session's last `session.json`, null when it could not be read. */
export type SessionDeletedListener = (
  id: string,
  deleted: SessionFile | null,
) => void | Promise<void>

const deletedListeners = new Set<SessionDeletedListener>()

const UNAVAILABLE_TITLE = 'Unavailable session'

export function setSessionDeps(deps: SessionFileDeps): void {
  setSessionFileDeps(deps)
}

/** The folder every Session Folder lives in (the demo root in demo mode). */
export function sessionsRootDir(): string {
  return sessionsRoot()
}

export function sessionPaths(id: string): SessionFolderPaths {
  return sessionFolderPaths(id)
}

function summaryOf(file: SessionFile): SessionSummary {
  const { id, title, renamed, pinned, createdAt, updatedAt, presetsUsed } = file
  return { id, title, renamed, pinned, createdAt, updatedAt, presetsUsed }
}

export async function readSession(id: string): Promise<SessionFile> {
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
    pinned: false,
    createdAt: now,
    updatedAt: now,
    presetsUsed: [],
    timeline: [],
    settings: {},
    harnessSessions: {},
    harnessWorkspaces: {},
    retiredHarnessSessions: [],
    taskRunHarnessSessions: [],
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
        renamed: false,
        pinned: false,
        unreadable: true,
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

export function sessionDocumentOf(file: SessionFile): SessionDocument {
  return { ...summaryOf(file), timeline: file.timeline }
}

export async function openSession(id: string): Promise<SessionDocument> {
  return sessionDocumentOf(await readSession(id))
}

/** Read-modify-write of one `session.json` on that Session's write chain. */
export async function mutateSession(
  id: string,
  mutate: (file: SessionFile) => SessionFile | Promise<SessionFile>,
): Promise<SessionFile> {
  assertSessionId(id)
  return serializeSession(id, async () => {
    const next = await mutate(await readSession(id))
    await writeSessionFile(next)
    return next
  })
}

async function clearedTitle(id: string): Promise<string> {
  const [first] = await readHistoryEntries(id)
  return first ? autoTitle(first) : ''
}

/**
 * A blank title clears the Name, back to the Title the first History Entry gives.
 * History is read on the write chain so a first turn settling alongside keeps its Title.
 */
export async function renameSession(id: string, title: string): Promise<SessionSummary> {
  const name = title.trim() ? SessionTitleSchema.parse(title) : null
  const file = await mutateSession(id, async (current) => {
    const [nextTitle, renamed] = name === null ? [await clearedTitle(id), false] : [name, true]
    return { ...current, title: nextTitle, renamed }
  })
  emitSessionChanged(sessionDocumentOf(file))
  return summaryOf(file)
}

export async function pinSession(id: string, pinned: boolean): Promise<SessionSummary> {
  const file = await mutateSession(id, (current) => ({ ...current, pinned }))
  emitSessionChanged(sessionDocumentOf(file))
  return summaryOf(file)
}

/** Removes the Session Folder, then lets owners of Session-bound data (Tasks, Harness Sessions) clean up. */
export async function deleteSession(id: string): Promise<void> {
  assertSessionId(id)
  const deleted = await serializeSession(id, async () => {
    const read = await readSessionFile(id)
    await removeSessionFolder(id)
    return read.status === 'ok' ? read.file : null
  })
  for (const listener of deletedListeners) await listener(id, deleted)
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
