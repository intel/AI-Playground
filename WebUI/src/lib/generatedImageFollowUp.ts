import type { ModelMessage, ToolResultPart } from 'ai'

// The OpenAI-compatible provider JSON.stringifies a tool result, so a result
// image sent there arrives as text, and edit runs also stamp a placeholder
// 512×512 into settings. A vision model gets the image as a following user
// file part. A model without vision gets the same refs with the settings
// removed, and never a file part.

const MEDIA_RESULT_TOOLS = new Set(['comfyUI', 'comfyUiImageEdit', 'media'])

const ATTACHED_MARKER = 'attached in the following message'

export type GeneratedImageReader = (url: string) => Promise<string>

type ImageEntry = {
  id?: string
  type?: string
  imageUrl?: string
  videoUrl?: string
  model3dUrl?: string
  settings?: { preset?: unknown }
}

function resultRecord(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== 'object') return null
  const wrapped = output as { type?: string; value?: unknown }
  if (wrapped.type === 'json' && wrapped.value && typeof wrapped.value === 'object') {
    return wrapped.value as Record<string, unknown>
  }
  if (Array.isArray((output as { images?: unknown }).images)) {
    return output as Record<string, unknown>
  }
  return null
}

function imageEntries(value: Record<string, unknown>): ImageEntry[] {
  if (!Array.isArray(value.images)) return []
  return value.images.filter(
    (item): item is ImageEntry => typeof item === 'object' && item !== null,
  )
}

function slimEntry(item: ImageEntry): Record<string, string> | null {
  if (typeof item.type !== 'string') return null
  const slim: Record<string, string> = { type: item.type }
  if (typeof item.id === 'string') slim.id = item.id
  if (typeof item.imageUrl === 'string') slim.imageUrl = item.imageUrl
  if (typeof item.videoUrl === 'string') slim.videoUrl = item.videoUrl
  if (typeof item.model3dUrl === 'string') slim.model3dUrl = item.model3dUrl
  return slim
}

function hasSettings(images: ImageEntry[]): boolean {
  return images.some((item) => item.settings != null)
}

function presetOf(images: ImageEntry[]): string | undefined {
  const preset = images.find((item) => typeof item.settings?.preset === 'string')?.settings?.preset
  return typeof preset === 'string' ? preset : undefined
}

/** Model-facing comfy tool output: image refs only, never the settings payload. */
export function comfyToolModelOutput(output: unknown): ToolResultPart['output'] {
  const value = resultRecord(output) ?? (output as Record<string, unknown> | null)
  if (!value || typeof value !== 'object') {
    return { type: 'error-text', value: 'Image generation returned no result.' }
  }
  const images = imageEntries(value)
  const message = typeof value.message === 'string' ? value.message : undefined
  if (value.success === false || images.length === 0) {
    return { type: 'error-text', value: message ?? 'Image generation failed.' }
  }
  const preset = presetOf(images)
  const summary = typeof value.summary === 'string' ? value.summary : undefined
  return {
    type: 'json',
    value: {
      summary: summary ?? (preset ? `Image generated with ${preset}.` : 'Image generated.'),
      images: images.map(slimEntry).filter((item) => item !== null),
    },
  }
}

function resultText(
  count: number,
  summary: string | undefined,
  preset: string | undefined,
): string {
  const lead = summary
    ? summary
    : preset
      ? count === 1
        ? `Image generated with ${preset}.`
        : `${count} images generated with ${preset}.`
      : count === 1
        ? 'Image generated.'
        : `${count} images generated.`
  const noun = count === 1 ? 'The result image is' : 'The result images are'
  return `${lead} ${noun} ${ATTACHED_MARKER}.`
}

function mediaTypeOf(dataUri: string): string {
  return /^data:(image\/[a-zA-Z0-9.+-]+);/i.exec(dataUri)?.[1] ?? 'image/png'
}

async function readImage(url: string, read: GeneratedImageReader): Promise<string> {
  if (url.startsWith('data:')) return url
  return await read(url)
}

function followUpMessage(dataUris: string[]): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'Here is the generated image to inspect:' },
      ...dataUris.map((dataUri) => ({
        type: 'file' as const,
        mediaType: mediaTypeOf(dataUri),
        data: { type: 'url' as const, url: new URL(dataUri) },
      })),
    ],
  }
}

/**
 * Rewrites media tool results before a model call. Settings payloads are
 * dropped always. When `vision` is set, each result image is read and attached
 * as a user message after the tool result.
 */
export async function attachGeneratedImageFollowUps(
  messages: ModelMessage[],
  options: { read: GeneratedImageReader; vision: boolean },
): Promise<ModelMessage[]> {
  const rewritten: ModelMessage[] = []
  let changed = false
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      rewritten.push(message)
      continue
    }
    const pieces = await Promise.all(
      message.content.map(async (part) => {
        const presented = await presentMediaResult(part as ToolResultPart, options)
        return presented ?? { part, images: [] as string[] }
      }),
    )
    if (pieces.every((piece, index) => piece.part === message.content[index])) {
      rewritten.push(message)
      continue
    }
    changed = true
    rewritten.push({ ...message, content: pieces.map((piece) => piece.part) } as ModelMessage)
    const attached = pieces.flatMap((piece) => piece.images)
    if (attached.length > 0) rewritten.push(followUpMessage(attached))
  }
  return changed ? rewritten : messages
}

async function presentMediaResult(
  toolPart: ToolResultPart,
  options: { read: GeneratedImageReader; vision: boolean },
): Promise<{ part: ToolResultPart; images: string[] } | null> {
  if (toolPart.type !== 'tool-result' || !MEDIA_RESULT_TOOLS.has(toolPart.toolName ?? '')) {
    return null
  }
  if (
    toolPart.output?.type === 'text' &&
    typeof toolPart.output.value === 'string' &&
    toolPart.output.value.includes(ATTACHED_MARKER)
  ) {
    return null
  }
  const value = resultRecord(toolPart.output)
  if (!value) return null
  const images = imageEntries(value)
  if (value.success === false) {
    return { part: { ...toolPart, output: comfyToolModelOutput(value) }, images: [] }
  }
  const urls = images
    .filter((item) => item.type === 'image' && typeof item.imageUrl === 'string')
    .map((item) => item.imageUrl as string)
  if (options.vision && urls.length > 0) {
    try {
      const dataUris = await Promise.all(urls.map((url) => readImage(url, options.read)))
      const summary = typeof value.summary === 'string' ? value.summary.trim() : ''
      return {
        part: {
          ...toolPart,
          output: {
            type: 'text',
            value: resultText(dataUris.length, summary || undefined, presetOf(images)),
          },
        },
        images: dataUris,
      }
    } catch {
      // A read failure still drops the settings payload.
    }
  }
  if (!hasSettings(images) && toolPart.output?.type === 'json') return null
  if (images.length === 0) return null
  return { part: { ...toolPart, output: comfyToolModelOutput(value) }, images: [] }
}
