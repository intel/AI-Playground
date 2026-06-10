// Single source of truth for "what shippable media does a finished tool part
// contain". Tool outputs put their user-visible media in tool-specific shapes
// (`output.images[]`, `output.dataUri`, `output.annotatedImageUrl`, …). Anything
// that needs to forward that media without re-rendering it (today: the Home Agent
// channel shipper) should go through `extractToolMedia` instead of re-encoding
// per-tool knowledge. A new media-producing tool only needs a case added here.

export type ToolMediaKind = 'image' | 'video' | 'model3d'

export type ToolMediaItem = { kind: ToolMediaKind; url: string }

/** Minimal shape of a tool UI part the extractor cares about. */
type MediaToolPart = { type: string; state?: string; output?: unknown }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** ComfyUI / ComfyUI image-edit: `output.images[]` is a discriminated union of
 *  `{ type: 'image' | 'video' | 'model3d', imageUrl?/videoUrl?/model3dUrl? }`. */
function extractComfyMedia(output: unknown): ToolMediaItem[] {
  const record = asRecord(output)
  const images = record?.images
  if (!Array.isArray(images)) return []
  const items: ToolMediaItem[] = []
  for (const raw of images) {
    const media = asRecord(raw)
    if (!media) continue
    if (media.type === 'image') {
      const url = nonEmptyString(media.imageUrl)
      if (url) items.push({ kind: 'image', url })
    } else if (media.type === 'video') {
      const url = nonEmptyString(media.videoUrl)
      if (url) items.push({ kind: 'video', url })
    } else if (media.type === 'model3d') {
      const url = nonEmptyString(media.model3dUrl)
      if (url) items.push({ kind: 'model3d', url })
    }
  }
  return items
}

/** captureScreenshot / screenshotWebPage: `{ ok, dataUri }` (a data: URL image). */
function extractOkDataUriImage(output: unknown): ToolMediaItem[] {
  const record = asRecord(output)
  if (!record || record.ok !== true) return []
  const url = nonEmptyString(record.dataUri)
  return url ? [{ kind: 'image', url }] : []
}

/** visualizeObjectDetections: `{ annotatedImageUrl }` (a data: URL image). */
function extractAnnotatedImage(output: unknown): ToolMediaItem[] {
  const record = asRecord(output)
  const url = nonEmptyString(record?.annotatedImageUrl)
  return url ? [{ kind: 'image', url }] : []
}

const EXTRACTORS: Record<string, (_output: unknown) => ToolMediaItem[]> = {
  'tool-comfyUI': extractComfyMedia,
  'tool-comfyUiImageEdit': extractComfyMedia,
  'tool-captureScreenshot': extractOkDataUriImage,
  'tool-screenshotWebPage': extractOkDataUriImage,
  'tool-visualizeObjectDetections': extractAnnotatedImage,
}

/** Tool part types that produce shippable media (useful for callers that only
 *  need to know "does this tool emit media" without extracting it). */
export const MEDIA_TOOL_TYPES: ReadonlySet<string> = new Set(Object.keys(EXTRACTORS))

/**
 * Extract every shippable media item from a finished tool part. Returns `[]` for
 * non-media tools, for parts that haven't produced output yet, and for failed /
 * empty outputs — so callers can blindly iterate the result.
 */
export function extractToolMedia(part: MediaToolPart): ToolMediaItem[] {
  if (part.state !== 'output-available') return []
  const extractor = EXTRACTORS[part.type]
  if (!extractor) return []
  return extractor(part.output)
}
