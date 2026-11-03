import path from 'node:path'
import { readHistoryEntries } from './sessionHistory'
import { mutateSession, readSession, sessionPaths } from './sessions'
import type { HistoryEntry } from '@/types/sessionIpc'

const UPDATE_CAP = 1500
const EXCERPT_CHARS = 120
const LIST_PROMPT_CHARS = 80
const HEADER = 'Session Update — what happened in this Session since your last turn:'

/** A reader of Session Updates: an agent preset's Harness Session, or the Session's chat. */
export type SessionUpdateConsumer = {
  /** Its cursor's key in `session.json` `updateCursors`. */
  key: string
  /** Entries of this preset are the consumer's own turns, not news. */
  ownPreset?: string
  isOwn?: (entry: HistoryEntry) => boolean
  /** Where the consumer opens files from; Session Folder paths inside it are shown relative to it. */
  workspaceDir?: string
}

export type SessionUpdateOptions = {
  artifactPath?: (sessionRelativePath: string) => string
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function clock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function outcomeOf(entry: HistoryEntry, artifactPath: (p: string) => string): string {
  if (entry.artifacts.length > 0) return entry.artifacts.map((a) => artifactPath(a.path)).join(', ')
  if (entry.response) return `"${excerpt(entry.response, EXCERPT_CHARS)}"`
  return `(${entry.status})`
}

function updateLine(entry: HistoryEntry, artifactPath: (p: string) => string): string {
  const prompt = excerpt(entry.prompt, EXCERPT_CHARS)
  return `[${clock(entry.timestamp)}] ${entry.preset}: "${prompt}" → ${outcomeOf(entry, artifactPath)}`
}

const omittedLine = (count: number) => `${count} earlier entries omitted — use \`session_history\``

/** The templated digest of `entries` (oldest first), capped keeping the newest; null when empty. */
export function buildSessionUpdate(
  entries: HistoryEntry[],
  options: SessionUpdateOptions = {},
): string | null {
  if (entries.length === 0) return null
  const artifactPath = options.artifactPath ?? ((p: string) => p)
  const kept: string[] = []
  let length = HEADER.length
  for (let index = entries.length - 1; index >= 0; index--) {
    const line = updateLine(entries[index], artifactPath)
    const omitted = index > 0 ? omittedLine(index).length + 1 : 0
    if (kept.length > 0 && length + line.length + 1 + omitted > UPDATE_CAP) break
    kept.unshift(line)
    length += line.length + 1
  }
  const omitted = entries.length - kept.length
  return [HEADER, ...kept, ...(omitted > 0 ? [omittedLine(omitted)] : [])].join('\n')
}

function workspacePathView(sessionId: string, workspaceDir: string | undefined) {
  if (!workspaceDir) return (p: string) => p
  const { root } = sessionPaths(sessionId)
  return (sessionRelative: string) => {
    const relative = path.relative(workspaceDir, path.resolve(root, sessionRelative))
    if (relative.startsWith('..') || path.isAbsolute(relative)) return sessionRelative
    return relative.split(path.sep).join('/')
  }
}

/**
 * The consumer's Session Update since its last turn, advancing its cursor to the
 * newest entry read — call it once when the turn starts.
 */
export async function takeSessionUpdate(
  sessionId: string,
  consumer: SessionUpdateConsumer,
): Promise<string | null> {
  const [file, entries] = await Promise.all([readSession(sessionId), readHistoryEntries(sessionId)])
  const cursor = file.updateCursors[consumer.key]
  const start = cursor ? entries.findIndex((entry) => entry.id === cursor) + 1 : 0
  const missed = entries
    .slice(start)
    .filter((entry) => entry.preset !== consumer.ownPreset && !(consumer.isOwn?.(entry) ?? false))
  const newest = entries.at(-1)
  if (newest && newest.id !== cursor) {
    await mutateSession(sessionId, (current) => ({
      ...current,
      updateCursors: { ...current.updateCursors, [consumer.key]: newest.id },
    }))
  }
  return buildSessionUpdate(missed, {
    artifactPath: workspacePathView(sessionId, consumer.workspaceDir),
  })
}

export type SessionHistoryRow = { id: string; time: string; preset: string; prompt: string }

/** `session_history list`: newest first, optionally one preset's entries, paged. */
export async function listSessionHistory(
  sessionId: string,
  query: { preset?: string; limit?: number; offset?: number },
): Promise<SessionHistoryRow[]> {
  const offset = Math.max(0, query.offset ?? 0)
  const limit = Math.max(1, query.limit ?? 20)
  return (await readHistoryEntries(sessionId))
    .filter((entry) => !query.preset || entry.preset === query.preset)
    .reverse()
    .slice(offset, offset + limit)
    .map((entry) => ({
      id: entry.id,
      time: new Date(entry.timestamp).toISOString(),
      preset: entry.preset,
      prompt: excerpt(entry.prompt, LIST_PROMPT_CHARS),
    }))
}

/** `session_history get`: one entry in full, artifact paths as `workspaceDir` sees them. */
export async function getSessionHistoryEntry(
  sessionId: string,
  id: string,
  workspaceDir?: string,
): Promise<HistoryEntry | null> {
  const entry = (await readHistoryEntries(sessionId)).find((candidate) => candidate.id === id)
  if (!entry) return null
  const artifactPath = workspacePathView(sessionId, workspaceDir)
  return {
    ...entry,
    artifacts: entry.artifacts.map((artifact) => ({
      ...artifact,
      path: artifactPath(artifact.path),
    })),
  }
}
