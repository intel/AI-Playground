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
  pinned: z.boolean().default(false),
  /** The Session Group it is in; one that no longer resolves lists as ungrouped. */
  groupId: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  presetsUsed: z.array(z.string()).default([]),
  timeline: z.array(z.unknown()).default([]),
  /** Session Settings, keyed by preset name. */
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Harness Session id per agent preset. */
  harnessSessions: z.record(z.string(), z.string()).default({}),
  /** Game folder per games preset (Game Agent, Quick Coder); other presets work in `files/`. */
  harnessWorkspaces: z.record(z.string(), z.string()).default({}),
  /** Harness Sessions a hand-over replaced; still the Session's, so deleted with it. */
  retiredHarnessSessions: z.array(z.string()).default([]),
  /** One fresh Harness Session per Task Run; never resumed, deleted with the Session. */
  taskRunHarnessSessions: z.array(z.string()).default([]),
  /** Last History Entry id each Session Update consumer has seen. */
  updateCursors: z.record(z.string(), z.string()).default({}),
})

export type SessionFile = z.infer<typeof SessionFileSchema>

/** One row of the Sessions panel. */
export type SessionSummary = Pick<
  SessionFile,
  'id' | 'title' | 'renamed' | 'pinned' | 'groupId' | 'createdAt' | 'updatedAt' | 'presetsUsed'
> & { unreadable?: boolean }

/** What opening a Session hands the renderer: its row plus the display timeline. */
export type SessionDocument = SessionSummary & { timeline: unknown[] }

export const SESSION_NAME_MAX_LENGTH = 500

export const SessionTitleSchema = z.string().trim().min(1).max(SESSION_NAME_MAX_LENGTH)

export const SessionGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number().int().nonnegative(),
  expanded: z.boolean().default(true),
})

export type SessionGroup = z.infer<typeof SessionGroupSchema>

/** The one Session Groups file beside the Session Folders. */
export const SessionGroupsFileSchema = z.object({
  schemaVersion: z.literal(1),
  groups: z.array(SessionGroupSchema).default([]),
  /** Whether Pinned lists every pinned Session instead of the three most recent. */
  pinnedShowMore: z.boolean().default(false),
})

export type SessionGroupsFile = z.infer<typeof SessionGroupsFileSchema>

export type SessionGroupsState = Pick<SessionGroupsFile, 'groups' | 'pinnedShowMore'>

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

/** The newest artifact of one media type in a Session, as the History Entry that holds it. */
export type NewestArtifact = { entryId: string; path: string; url: string }

export type HistoryArtifact = HistoryEntry['artifacts'][number]

/** A Session's Harness Session for one agent preset, and the workspace it runs in. */
export type HarnessSessionRef = { harnessSessionId: string; workspaceDir: string }

/**
 * A games preset's Harness Session works in a game folder: none until the first turn
 * mints one (`gameDir`), and `fresh` starts a new Harness Session on a handed-over game.
 */
export const HarnessGameWorkspaceSchema = z.object({
  kind: z.literal('game'),
  gameDir: z.string().min(1).optional(),
  fresh: z.boolean().optional(),
})

export type HarnessGameWorkspace = z.infer<typeof HarnessGameWorkspaceSchema>

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
/** One file a History Entry produced, as the gallery lists it. */
export type SessionArtifact = {
  sessionId: string
  sessionTitle: string
  entryId: string
  timestamp: number
  preset: string
  kind: HistoryEntryKind
  prompt: string
  /** Relative to the Session Folder. */
  path: string
  mediaType: ArtifactMediaType
  url: string
}

export const SessionTurnKindSchema = z.enum(['chat', 'agent', 'media', 'audio'])
export type SessionTurnKind = z.infer<typeof SessionTurnKindSchema>

/** The one turn a Session has in flight; the engine keys say where Stop must go. */
export const SessionTurnSchema = z.object({
  turnId: z.string().min(1),
  kind: SessionTurnKindSchema,
  presetName: z.string().optional(),
  harnessSessionId: z.string().optional(),
  conversationKey: z.string().optional(),
})
export type SessionTurn = z.infer<typeof SessionTurnSchema>

/** Every Session with a turn in flight, by Session id. */
export type SessionTurns = Record<string, SessionTurn>

/** The preset and variant of a Session's last turn, which opening it switches to. */
export type SessionLastPreset = { preset: string; variant?: string }
