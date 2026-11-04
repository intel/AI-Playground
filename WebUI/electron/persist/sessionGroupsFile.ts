import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { atomicWriteJson, makeWriteChains, readJson } from './fsJsonStore'
import { sessionsRoot } from './sessionFiles'
import {
  SessionGroupsFileSchema,
  type SessionGroup,
  type SessionGroupsFile,
} from '@/types/sessionIpc'

const LOG_SCOPE = 'sessions'

export const SESSION_GROUPS_FILE = 'session-groups.json'

const chains = makeWriteChains()

function groupsFilePath(): string {
  return path.join(sessionsRoot(), SESSION_GROUPS_FILE)
}

/** Groups-file mutations of one root run in order; a Session's own chain may nest inside. */
export function serializeSessionGroups<T>(run: () => Promise<T>): Promise<T> {
  return chains.serialize(sessionsRoot(), run)
}

export type SessionGroupsRead = { status: 'ok'; file: SessionGroupsFile } | { status: 'unreadable' }

export async function readSessionGroupsFile(): Promise<SessionGroupsRead> {
  const read = await readJson(groupsFilePath(), LOG_SCOPE)
  if (read.status === 'missing') {
    return { status: 'ok', file: { schemaVersion: 1, groups: [], pinnedShowMore: false } }
  }
  if (read.status === 'corrupt') return { status: 'unreadable' }
  const parsed = SessionGroupsFileSchema.safeParse(read.value)
  if (parsed.success) return { status: 'ok', file: parsed.data }
  appLoggerInstance.warn('session groups file failed schema', LOG_SCOPE)
  return { status: 'unreadable' }
}

export async function writeSessionGroupsFile(file: SessionGroupsFile): Promise<void> {
  await atomicWriteJson(groupsFilePath(), file)
}

/** Replaces the Groups, keeping the rest of the file; callers already hold the chain. */
export async function writeSessionGroups(groups: SessionGroup[]): Promise<void> {
  const read = await readSessionGroupsFile()
  const pinnedShowMore = read.status === 'ok' && read.file.pinnedShowMore
  await writeSessionGroupsFile({ schemaVersion: 1, groups, pinnedShowMore })
}

export function resetSessionGroupsFileForTest(): void {
  chains.clear()
}
