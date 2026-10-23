import { z } from 'zod'
import type { MediaItem } from './mediaItem'

/**
 * Wire shapes for the kernel-owned generated-media records
 * (architecture-target §6.1, step 8): one JSON per gallery item under
 * `media/records/` plus an `index.json` with the ordered id list. The wire
 * shape is MediaItem itself; the schema is deliberately lenient
 * (`settings` / `dynamicSettings` are freeform ComfyUI shapes) — everything
 * the gallery renders must survive a round trip.
 */

const baseFields = {
  id: z.string().min(1),
  state: z.enum(['queued', 'generating', 'done', 'stopped', 'failed']),
  mode: z.string(),
  settings: z.record(z.string(), z.unknown()).optional(),
  dynamicSettings: z.array(z.unknown()).optional(),
  createdAt: z.number().optional(),
  sourceImageUrl: z.string().optional(),
}

// The per-type url is required on the wire: only terminal `done` items reach
// a record file, and a done item without its url renders as nothing.
export const MediaItemFileSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...baseFields,
      type: z.literal('image'),
      imageUrl: z.string(),
      fromImageGen: z.boolean().optional(),
      isNsfwBlocked: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      ...baseFields,
      type: z.literal('video'),
      videoUrl: z.string(),
      thumbnailUrl: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      ...baseFields,
      type: z.literal('model3d'),
      model3dUrl: z.string(),
      thumbnailUrl: z.string().optional(),
    })
    .passthrough(),
])

export const MediaItemIndexFileSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(z.string()),
})
export type MediaItemIndexFile = z.infer<typeof MediaItemIndexFileSchema>

export type MediaItemsBootstrap = { status: 'empty' } | { status: 'ok'; items: MediaItem[] }
