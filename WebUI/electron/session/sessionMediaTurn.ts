import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { emitSessionChanged } from '../kernel/kernelBus'
import { SESSION_FILES_DIR } from '../persist/sessionFiles'
import { appendHistoryEntry } from './sessionHistory'
import { mutateSession, sessionDocumentOf, sessionPaths } from './sessions'
import { sessionMediaUrl } from '@/lib/comfyWorkflow'
import type { MediaItem } from '@/types/mediaItem'
import type { ArtifactMediaType, HistoryEntryKind, SessionDocument } from '@/types/sessionIpc'
import type { MediaTurnData, MediaTurnStatus, TimelineMessage } from '@/types/sessionTimeline'

const LOG_SCOPE = 'sessions'
const TITLE_LIMIT = 60

export type MediaTurn = {
  sessionId: string
  runId: string
  mode: MediaTurnData['mode']
  preset: string
  variant?: string
  prompt: string
  status: MediaTurnStatus
  error?: string
  /** The run's finished items, still pointing at ComfyUI's output directory. */
  items: MediaItem[]
  /** Resolves an `aipg-media://` URL to the file it names, or null when it names none. */
  localPathOf: (url: string) => string | null
}

const KIND_OF_MODE: Record<MediaTurn['mode'], HistoryEntryKind> = {
  imageGen: 'image',
  imageEdit: 'edit',
  video: 'video',
}

export function titleFromPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return flat.length <= TITLE_LIMIT ? flat : `${flat.slice(0, TITLE_LIMIT - 1).trimEnd()}…`
}

export async function freeName(dir: string, name: string): Promise<string> {
  const { name: stem, ext } = path.parse(name)
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem}-${n}${ext}`
    try {
      await fs.access(path.join(dir, candidate))
    } catch {
      return candidate
    }
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await fs.copyFile(from, to)
    await fs.unlink(from)
  }
}

type Moved = { url: string; relativePath: string }

/** Moves the file behind `url` into the Session's `files/`; null leaves the URL as it was. */
async function adoptFile(turn: MediaTurn, url: string | undefined): Promise<Moved | null> {
  if (!url?.startsWith('aipg-media://media/')) return null
  const source = turn.localPathOf(url)
  if (!source) return null
  const filesDir = sessionPaths(turn.sessionId).filesDir
  try {
    if (!(await fs.stat(source)).isFile()) return null
    await fs.mkdir(filesDir, { recursive: true })
    const name = await freeName(filesDir, path.basename(source))
    await moveFile(source, path.join(filesDir, name))
    const relativePath = `${SESSION_FILES_DIR}/${name}`
    return { url: sessionMediaUrl(turn.sessionId, relativePath), relativePath }
  } catch (error) {
    appLoggerInstance.warn(`could not move ${source} into its Session: ${error}`, LOG_SCOPE)
    return null
  }
}

function withoutInlineImages(item: MediaItem): MediaItem {
  const inline = (value: unknown) => typeof value === 'string' && value.startsWith('data:')
  return {
    ...item,
    sourceImageUrl: inline(item.sourceImageUrl) ? undefined : item.sourceImageUrl,
    dynamicSettings: item.dynamicSettings?.map((input) =>
      inline(input.current) ? { ...input, current: '' as never } : input,
    ),
  } as MediaItem
}

type AdoptedItem = { item: MediaItem; artifact?: { path: string; mediaType: ArtifactMediaType } }

async function adoptItem(turn: MediaTurn, item: MediaItem): Promise<AdoptedItem> {
  const mainUrl =
    item.type === 'image' ? item.imageUrl : item.type === 'video' ? item.videoUrl : item.model3dUrl
  const main = await adoptFile(turn, mainUrl)
  const thumbnail = item.type === 'image' ? null : await adoptFile(turn, item.thumbnailUrl)
  const patch: Partial<MediaItem> = {}
  if (main) {
    if (item.type === 'image') Object.assign(patch, { imageUrl: main.url })
    else if (item.type === 'video') Object.assign(patch, { videoUrl: main.url })
    else Object.assign(patch, { model3dUrl: main.url })
  }
  if (thumbnail) Object.assign(patch, { thumbnailUrl: thumbnail.url })
  return {
    item: withoutInlineImages({ ...item, ...patch } as MediaItem),
    artifact: main ? { path: main.relativePath, mediaType: item.type } : undefined,
  }
}

/**
 * Settles one Image Gen / Edit / Video panel run into its Session: the outputs
 * move into `files/`, one History Entry is appended, and the prompt plus the
 * result card join the display timeline. Returns the items as they now are.
 */
export async function recordMediaTurn(turn: MediaTurn): Promise<MediaItem[]> {
  const adopted: AdoptedItem[] = []
  for (const item of turn.items) adopted.push(await adoptItem(turn, item))
  const items = adopted.map(({ item }) => item)

  await appendHistoryEntry(turn.sessionId, {
    preset: turn.preset,
    variant: turn.variant,
    kind: KIND_OF_MODE[turn.mode],
    prompt: turn.prompt,
    status: turn.status,
    artifacts: adopted.flatMap(({ artifact }) => (artifact ? [artifact] : [])),
  })

  const now = Date.now()
  const messages: TimelineMessage[] = [
    {
      id: `msg-${randomUUID()}`,
      role: 'user',
      createdAt: now,
      parts: [{ type: 'text', text: turn.prompt }],
    },
    {
      id: `msg-${randomUUID()}`,
      role: 'assistant',
      createdAt: now,
      parts: [
        {
          type: 'data-media',
          data: {
            runId: turn.runId,
            mode: turn.mode,
            preset: turn.preset,
            variant: turn.variant,
            status: turn.status,
            error: turn.error,
            items,
          },
        },
      ],
    },
  ]
  await appendTurnToTimeline(turn.sessionId, {
    preset: turn.preset,
    titleSource: turn.prompt,
    messages,
    at: now,
  })
  return items
}

/**
 * Appends a settled turn's messages to the Session's display timeline, titles
 * an untitled Session from it and tells the renderer.
 */
export async function appendTurnToTimeline(
  sessionId: string,
  turn: { preset: string; titleSource: string; messages: TimelineMessage[]; at: number },
): Promise<SessionDocument> {
  const file = await mutateSession(sessionId, (current) => ({
    ...current,
    title:
      current.renamed || current.title
        ? current.title
        : titleFromPrompt(turn.titleSource) || turn.preset,
    presetsUsed: current.presetsUsed.includes(turn.preset)
      ? current.presetsUsed
      : [...current.presetsUsed, turn.preset],
    timeline: [...current.timeline, ...turn.messages],
    updatedAt: Math.max(turn.at, current.updatedAt),
  }))
  const document = sessionDocumentOf(file)
  emitSessionChanged(document)
  return document
}
