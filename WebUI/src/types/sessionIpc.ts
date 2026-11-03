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

export const HistoryEntryKindSchema = z.enum([
  'chat',
  'agent',
  'image',
  'edit',
  'video',
  'tts',
  'stt',
])

export const ArtifactMediaTypeSchema = z.enum(['image', 'video', 'audio', 'model3d'])

/** One line of `session-history.jsonl`: a settled turn, never rewritten. */
export const HistoryEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number().int().nonnegative(),
  preset: z.string(),
  variant: z.string().optional(),
  kind: HistoryEntryKindSchema,
  prompt: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  /** Paths relative to the Session Folder. */
  artifacts: z.array(z.object({ path: z.string(), mediaType: ArtifactMediaTypeSchema })),
  response: z.string().optional(),
  taskName: z.string().optional(),
  stepIndex: z.number().int().nonnegative().optional(),
})

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>
export type HistoryEntryKind = z.infer<typeof HistoryEntryKindSchema>
export type ArtifactMediaType = z.infer<typeof ArtifactMediaTypeSchema>

/** A settled Text-to-Speech / Speech-to-Text turn the renderer hands the Session module. */
export const AudioTurnRequestSchema = z.object({
  sessionId: z.string(),
  kind: z.enum(['tts', 'stt']),
  preset: z.string(),
  /** TTS: the text spoken; STT: what the source audio is called. */
  prompt: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  error: z.string().optional(),
  /** STT only. */
  transcript: z.string().optional(),
  engine: z.string().optional(),
  /** TTS: the synthesized clip; STT: the source audio. */
  audio: z.object({ base64: z.string().min(1), fileName: z.string().min(1) }).optional(),
})

export type AudioTurnRequest = z.infer<typeof AudioTurnRequestSchema>
