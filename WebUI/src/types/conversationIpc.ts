import { z } from 'zod'

/**
 * Conversation persistence IPC (architecture-target §6.1, steps 8 + 11): the
 * kernel is the one writer of the user's chat threads —
 * `AI-Playground/conversations/` holds one JSON file per thread plus
 * `index.json`. Chat-turn transcripts are written by the engine
 * (`saveConversation` on turn start and end). The renderer keeps its reactive
 * map as the live copy and forwards user mutations (rename, delete, TTS/STT)
 * here.
 *
 * Messages are opaque JSON on purpose: they are the AI SDK's `UIMessage`
 * documents, already sanitized by the sender (`completeOrphanedToolParts` +
 * `sanitizeBulkyToolOutputs`) and re-sanitized by the writer — validating the
 * SDK's full message shape here would couple this schema to the SDK version.
 */

export const ConversationThreadMetaSchema = z.object({
  presetName: z.string(),
  variant: z.string().nullable().optional(),
  kind: z.enum(['main', 'homeAgent']).optional(),
})

export type ConversationThreadMeta = z.infer<typeof ConversationThreadMetaSchema>

/** One thread's durable document (`conversations/<id>.json`). */
export const ConversationThreadFileSchema = z.object({
  schemaVersion: z.literal(1),
  meta: ConversationThreadMetaSchema.nullable(),
  ragHashes: z.array(z.string()),
  messages: z.array(z.unknown()),
  updatedAt: z.number().int().nonnegative(),
})

export type ConversationThreadFile = z.infer<typeof ConversationThreadFileSchema>

/** One entry of `conversations/index.json` — cheap to list without the files. */
export const ConversationIndexEntrySchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  presetName: z.string().optional(),
  kind: z.enum(['main', 'homeAgent']).optional(),
  updatedAt: z.number().int().nonnegative(),
})

export const ConversationIndexFileSchema = z.object({
  schemaVersion: z.literal(1),
  lastMainKey: z.string().nullable(),
  threads: z.array(ConversationIndexEntrySchema),
})

export type ConversationIndexEntry = z.infer<typeof ConversationIndexEntrySchema>
export type ConversationIndexFile = z.infer<typeof ConversationIndexFileSchema>

export const ConversationSaveRequestSchema = z.object({
  id: z.string().min(1),
  meta: ConversationThreadMetaSchema.nullable(),
  ragHashes: z.array(z.string()),
  messages: z.array(z.unknown()),
  lastMainKey: z.string().nullable().optional(),
})

export type ConversationSaveRequest = z.infer<typeof ConversationSaveRequestSchema>

/**
 * The one-shot legacy upload: the renderer's old Pinia-persisted state
 * (localStorage under the `conversations` key), shipped to the kernel the first
 * boot that finds no `index.json`. After this lands, the renderer never
 * persists threads itself again.
 */
export const ConversationLegacyStateSchema = z.object({
  conversationList: z.record(z.string(), z.array(z.unknown())),
  conversationThreadMeta: z.record(z.string(), ConversationThreadMetaSchema).default({}),
  conversationRagSelection: z.record(z.string(), z.array(z.string())).default({}),
  lastMainKey: z.string().nullable().default(null),
})

export type ConversationLegacyState = z.infer<typeof ConversationLegacyStateSchema>

/** A hydrated thread as `conversations:bootstrap` / `conversations:migrate` return it. */
export const ConversationHydratedThreadSchema = z.object({
  id: z.string(),
  meta: ConversationThreadMetaSchema.nullable(),
  ragHashes: z.array(z.string()),
  messages: z.array(z.unknown()),
})

export const ConversationBootstrapSchema = z.object({
  status: z.literal('ok'),
  lastMainKey: z.string().nullable(),
  threads: z.array(ConversationHydratedThreadSchema),
})

export const ConversationBootstrapEmptySchema = z.object({
  status: z.literal('empty'),
})

export type ConversationHydratedThread = z.infer<typeof ConversationHydratedThreadSchema>
export type ConversationBootstrap =
  z.infer<typeof ConversationBootstrapSchema> | z.infer<typeof ConversationBootstrapEmptySchema>
