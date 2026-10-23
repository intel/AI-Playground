import type { FilePart, ModelMessage } from 'ai'

/**
 * Reading a turn's attachments from main.
 *
 * A FilePart carries either raw bytes (the AI SDK hands over a
 * `Uint8Array`/`ArrayBuffer` whenever the attachment was built from binary), a
 * data URL, an `aipg-media://` reference, or an http URL — and v7 wraps some of
 * those as `{ type: 'url', url }`. `aipg-media://` is the app's own scheme, so
 * it is read through the engine's reader rather than fetched.
 */

// `convertToModelMessages` builds this wrapper around a `URL` instance, never a
// string, so a string-only check matches nothing it produces.
type FileUrlWrapper = { type: 'url'; url: string | URL }

function isFileUrlWrapper(data: unknown): data is FileUrlWrapper {
  if (!data || typeof data !== 'object') return false
  const wrapper = data as { type?: unknown; url?: unknown }
  return wrapper.type === 'url' && (typeof wrapper.url === 'string' || wrapper.url instanceof URL)
}

export type MediaReader = (url: string) => Promise<string>

/** The most recent attachment of `mediaTypePrefix` across the turn's user messages. */
export function findLatestAttachment(
  messages: ModelMessage[] | undefined,
  mediaTypePrefix: string,
): FilePart | undefined {
  return (messages ?? [])
    .filter((msg) => msg.role === 'user' && Array.isArray(msg.content))
    .flatMap((msg) => msg.content as Array<{ type: string; mediaType?: string }>)
    .findLast(
      (part): part is FilePart =>
        part.type === 'file' && part.mediaType?.startsWith(mediaTypePrefix) === true,
    )
}

export async function filePartToBase64(data: unknown, read: MediaReader): Promise<string> {
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64')
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('base64')
  if (isFileUrlWrapper(data)) return filePartToBase64(data.url, read)
  const url = typeof data === 'string' ? data : data instanceof URL ? data.href : null
  if (!url) {
    throw new Error('Unsupported attachment data (expected a data URL, URL, or raw bytes).')
  }
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const payload = comma >= 0 ? url.slice(comma + 1) : url
    return url.slice(0, comma).includes(';base64')
      ? payload
      : Buffer.from(decodeURIComponent(payload), 'binary').toString('base64')
  }
  if (url.startsWith('aipg-media://')) return filePartToBase64(await read(url), read)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Could not read the attachment (${response.status} ${response.statusText}).`)
  }
  return Buffer.from(await response.arrayBuffer()).toString('base64')
}

/** The same read, as a `data:` URI — what an image decoder wants. */
export async function filePartToDataUri(
  data: unknown,
  mediaType: string | undefined,
  read: MediaReader,
): Promise<string> {
  const base64 = await filePartToBase64(data, read)
  return `data:${mediaType || 'application/octet-stream'};base64,${base64}`
}
