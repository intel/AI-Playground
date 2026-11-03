import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { getSessionsDemoDir, getSessionsDir } from './userDataPaths.ts'
import { atomicWriteJson, isSafeFileId, makeWriteChains, readJson } from './fsJsonStore'
import { SessionFileSchema, type SessionFile } from '@/types/sessionIpc'

/**
 * The on-disk side of a Session Folder. Only the Session module calls this;
 * every mutation of one Session runs on that Session's write chain, so later
 * writers (History Entries, Session Settings) serialize with rename and delete.
 */

const appLogger = appLoggerInstance
const LOG_SCOPE = 'sessions'

export const SESSION_FILE = 'session.json'
export const SESSION_HISTORY_FILE = 'session-history.jsonl'
export const SESSION_FILES_DIR = 'files'

export type SessionFileDeps = {
  isDemoMode: () => boolean
}

let deps: SessionFileDeps | null = null

export function setSessionFileDeps(next: SessionFileDeps): void {
  deps = next
}

const chains = makeWriteChains()

export const serializeSession = chains.serialize

export function sessionsRoot(): string {
  return deps?.isDemoMode() ? getSessionsDemoDir() : getSessionsDir()
}

export type SessionFolderPaths = {
  root: string
  sessionFile: string
  historyFile: string
  filesDir: string
}

/** A Session id names a folder, so unlike a file stem it must never be `.` or `..`. */
export function isSessionId(id: string): boolean {
  return isSafeFileId(id) && !id.startsWith('.')
}

export function assertSessionId(id: string): void {
  if (!isSessionId(id)) throw new Error(`invalid session id: ${id}`)
}

export function sessionFolderPaths(id: string): SessionFolderPaths {
  assertSessionId(id)
  const root = path.join(sessionsRoot(), id)
  return {
    root,
    sessionFile: path.join(root, SESSION_FILE),
    historyFile: path.join(root, SESSION_HISTORY_FILE),
    filesDir: path.join(root, SESSION_FILES_DIR),
  }
}

export type SessionFileRead =
  { status: 'ok'; file: SessionFile } | { status: 'missing' } | { status: 'corrupt' }

export async function readSessionFile(id: string): Promise<SessionFileRead> {
  const read = await readJson(sessionFolderPaths(id).sessionFile, LOG_SCOPE)
  if (read.status !== 'ok') return read
  const parsed = SessionFileSchema.safeParse(read.value)
  if (parsed.success && parsed.data.id === id) return { status: 'ok', file: parsed.data }
  appLogger.warn(`session file failed schema (${id})`, LOG_SCOPE)
  return { status: 'corrupt' }
}

export async function writeSessionFile(file: SessionFile): Promise<void> {
  await atomicWriteJson(sessionFolderPaths(file.id).sessionFile, file)
}

export async function createSessionFolder(file: SessionFile): Promise<void> {
  const paths = sessionFolderPaths(file.id)
  await fs.mkdir(paths.filesDir, { recursive: true })
  await fs.writeFile(paths.historyFile, '', { flag: 'wx' })
  await writeSessionFile(file)
}

export async function removeSessionFolder(id: string): Promise<void> {
  await fs.rm(sessionFolderPaths(id).root, { recursive: true, force: true })
}

/** Every Session Folder under the active root; stray files and unsafe names are skipped. */
export async function listSessionFolders(): Promise<{ id: string; mtimeMs: number }[]> {
  const root = sessionsRoot()
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const folders = entries.filter((entry) => entry.isDirectory() && isSessionId(entry.name))
  return Promise.all(
    folders.map(async (entry) => ({
      id: entry.name,
      mtimeMs: (await fs.stat(path.join(root, entry.name))).mtimeMs,
    })),
  )
}

/** Demo Sessions are session-scoped (§6.1): wiped on exit, and on boot for a crash tail. */
export async function wipeDemoSessionFolders(): Promise<void> {
  try {
    await fs.rm(getSessionsDemoDir(), { recursive: true, force: true })
  } catch (error) {
    appLogger.warn(`demo session wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetSessionFilesForTest(): void {
  deps = null
  chains.clear()
}
