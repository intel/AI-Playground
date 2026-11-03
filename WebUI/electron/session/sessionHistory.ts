import { randomUUID } from 'node:crypto'
import { appLoggerInstance } from '../observability/logger'
import {
  appendHistoryLine,
  assertSessionId,
  readHistoryFile,
  serializeSession,
} from '../persist/sessionFiles'
import { HistoryEntrySchema, type HistoryEntry, type SessionLastPreset } from '@/types/sessionIpc'

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
    await appendHistoryLine(sessionId, JSON.stringify(written))
    return written
  })
}

/** Every readable entry in append order; a torn or foreign line is skipped. */
export async function readHistoryEntries(sessionId: string): Promise<HistoryEntry[]> {
  const raw = await readHistoryFile(sessionId)
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

/** The preset and variant of the newest entry, which opening the Session switches back to. */
export async function lastTurnPreset(sessionId: string): Promise<SessionLastPreset | null> {
  const last = (await readHistoryEntries(sessionId)).at(-1)
  if (!last) return null
  return last.variant ? { preset: last.preset, variant: last.variant } : { preset: last.preset }
}
