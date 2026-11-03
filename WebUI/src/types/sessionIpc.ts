import { z } from 'zod'

/**
 * A Session's `session.json` (ADR-0003). Everything the later tickets fill in
 * (display timeline, Session Settings, Harness Session pointers, Session Update
 * cursors) has a field from the start, defaulting empty, so the file never
 * needs a schema bump to grow into them. Timeline messages are opaque UI
 * messages, like a conversation file's.
 */
export const SessionFileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  /** Empty until the first prompt names the Session or the user renames it. */
  title: z.string(),
  /** Set once the user renames, so the first prompt no longer overwrites the title. */
  renamed: z.boolean().default(false),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  presetsUsed: z.array(z.string()).default([]),
  timeline: z.array(z.unknown()).default([]),
  /** Session Settings, keyed by preset name. */
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Harness Session id per agent preset. */
  harnessSessions: z.record(z.string(), z.string()).default({}),
  /** Last History Entry id each Session Update consumer has seen. */
  updateCursors: z.record(z.string(), z.string()).default({}),
})

export type SessionFile = z.infer<typeof SessionFileSchema>

/** One row of the Sessions panel. */
export type SessionSummary = Pick<
  SessionFile,
  'id' | 'title' | 'renamed' | 'createdAt' | 'updatedAt' | 'presetsUsed'
>

/** What opening a Session hands the renderer: its row plus the display timeline. */
export type SessionDocument = SessionSummary & { timeline: unknown[] }

export const SessionTitleSchema = z.string().trim().min(1).max(500)
