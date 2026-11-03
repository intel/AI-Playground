import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { appLoggerInstance } from '../observability/logger'
import { assertSessionId, serializeSession } from '../persist/sessionFiles'
import { sessionPaths } from './sessions'
import { HistoryEntrySchema, type HistoryEntry } from '@/types/sessionIpc'

const LOG_SCOPE = 'sessions'

export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'timestamp'>

/** Appends one History Entry on the Session's write chain; earlier lines are never touched. */
export async function appendHistoryEntry(
  sessionId: string,
  entry: NewHistoryEntry,
): Promise<HistoryEntry> {
  assertSessionId(sessionId)
  return serializeSession(sessionId, async () => {
    const written = HistoryEntrySchema.parse({
      ...entry,
      id: `entry-${randomUUID()}`,
      timestamp: Date.now(),
    })
    await fs.appendFile(sessionPaths(sessionId).historyFile, `${JSON.stringify(written)}\n`)
    return written
  })
}

/** Every readable entry in append order; a torn or foreign line is skipped. */
export async function readHistoryEntries(sessionId: string): Promise<HistoryEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(sessionPaths(sessionId).historyFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const entries: HistoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = HistoryEntrySchema.safeParse(JSON.parse(line))
      if (parsed.success) entries.push(parsed.data)
      else appLoggerInstance.warn(`history entry failed schema (${sessionId})`, LOG_SCOPE)
    } catch {
      appLoggerInstance.warn(`unreadable history line (${sessionId})`, LOG_SCOPE)
    }
  }
  return entries
}
