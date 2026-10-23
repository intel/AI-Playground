import type { FilePart, ModelMessage } from 'ai'

function hrefOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof URL) return value.href
  return null
}

/** String, URL, or the SDK's `{ type: 'url', url }` file-part wrapper. */
function filePartLocation(data: unknown): string | null {
  const direct = hrefOf(data)
  if (direct) return direct
  if (!data || typeof data !== 'object') return null
  const record = data as { type?: unknown; url?: unknown }
  if (record.type !== 'url') return null
  return hrefOf(record.url)
}

function usableImageRef(location: string): string | null {
  if (location.startsWith('data:image/') || location.startsWith('aipg-media://')) return location
  return null
}

function imageUrlFromEntry(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null
  const media = entry as { type?: string; imageUrl?: string }
  return media.type === 'image' && typeof media.imageUrl === 'string' && media.imageUrl !== ''
    ? media.imageUrl
    : null
}

function imagesFromToolOutput(result: unknown): unknown[] | null {
  if (typeof result !== 'object' || result === null) return null
  const record = result as { type?: string; value?: { images?: unknown }; images?: unknown }
  if (Array.isArray(record.images)) return record.images
  if (record.type === 'json' && Array.isArray(record.value?.images)) return record.value.images
  return null
}

function imageFromToolPart(part: unknown): string | null {
  if (typeof part !== 'object' || part === null) return null
  const record = part as { type?: string; toolName?: string; output?: unknown; result?: unknown }
  if (record.type !== 'tool-result') return null
  if (
    record.toolName !== 'comfyUI' &&
    record.toolName !== 'comfyUiImageEdit' &&
    record.toolName !== 'media'
  ) {
    return null
  }
  const images = imagesFromToolOutput(record.output ?? record.result)
  if (!images) return null
  for (const entry of images) {
    const url = imageUrlFromEntry(entry)
    if (url) return url
  }
  return null
}

function fileImageFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const imagePart = (
    content as Array<{ type: string; mediaType?: string; data?: unknown }>
  ).findLast(
    (part): part is FilePart =>
      part.type === 'file' && part.mediaType?.startsWith('image/') === true,
  )
  if (!imagePart) return null
  const location = filePartLocation(imagePart.data)
  return location ? usableImageRef(location) : null
}

function findLatestImageInConversation(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!Array.isArray(msg.content)) continue
    if (msg.role === 'tool') {
      for (const part of msg.content) {
        const url = imageFromToolPart(part)
        if (url) return url
      }
    }
    if (msg.role === 'user') {
      const url = fileImageFromContent(msg.content)
      if (url) return url
    }
  }
  return null
}

/** Most recent image in the conversation: a generated result after an upload wins. */
export function findSourceImage(messages: ModelMessage[]): string | null {
  return findLatestImageInConversation(messages)
}
