import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, net } from 'electron'
import { Type, type TSchema } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { AgentMediaDetails, AgentMediaItem } from '@/types/agentMediaDetails'
import { appLoggerInstance } from '../observability/logger.ts'
import { emitAgentToolImage } from '../kernel/kernelBus.ts'
import { typedSend } from '../kernel/typedIpc.ts'
import { moveFile } from '../persist/sessionMediaFiles.ts'
import { noteGeneratedMedia } from './generatedMedia.ts'
import { sessionMediaUrl } from '@/lib/comfyWorkflow'
import { agentTurns } from './piAgentState.ts'
import { isWaitingOnUser, onUserWaitChange, whileRendererAnswers } from '../kernel/userWait.ts'

// ── Agent Mode tool plumbing ─────────────────────────────────────────────────
//
// Shared machinery every capability's tools need (the capabilities themselves
// live in capabilities/, the file/shell builtins in piToolOperations.ts):
//
//  - the renderer tool bridge: AIPG tool implementations run in the RENDERER
//    against the Pinia stores that drive ComfyUI, so main only proxies over IPC.
//  - workspace file handling: inlining a workspace image as a data URI on the
//    way in, saving generated media into the workspace on the way out.
//  - skills: writing SKILL.md files and announcing them in the system prompt.
//
// Pi takes TypeBox parameter schemas, and `Type.Unsafe` passes a JSON Schema
// straight through — so the renderer keeps emitting plain JSON Schema and no
// schema conversion is needed on either side.

const logger = appLoggerInstance
const LOG_SOURCE = 'piCustomTools'

/** Pi wants tool output as message content; capability tools return text. */
export function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined }
}

export function jsonResult(value: unknown): AgentToolResult<undefined> {
  return textResult(typeof value === 'string' ? value : JSON.stringify(value ?? null))
}

export function mediaToolResult(
  value: unknown,
  steps?: string[],
): AgentToolResult<AgentMediaDetails | undefined> {
  const items = generatedItemsOf(value)
  const details = items.length > 0 || steps ? { items, ...(steps ? { steps } : {}) } : undefined
  return { ...jsonResult(value), details }
}

// A failed or cancelled run still lists its items, but none of them finished.
function generatedItemsOf(value: unknown): AgentMediaItem[] {
  const record = value as { images?: unknown; success?: unknown; savedFiles?: unknown } | null
  if (record?.success === false || !Array.isArray(record?.images)) return []
  const savedFiles = Array.isArray(record.savedFiles) ? record.savedFiles : []
  return record.images
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const saved = workspacePathForMediaUrl(mediaUrlOf(item))
      return {
        mode: 'imageGen',
        settings: {},
        ...item,
        state: 'done',
        ...(saved && savedFiles.includes(saved) ? { workspacePath: saved } : {}),
      } as AgentMediaItem
    })
}

function mediaUrlOf(item: Record<string, unknown>): unknown {
  return item.imageUrl ?? item.videoUrl ?? item.model3dUrl
}

/** Where `saveGeneratedMediaToWorkspace` puts a media URL's file in the workspace. */
function workspacePathForMediaUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url.startsWith('aipg-media://')) return undefined
  const parsed = new URL(url)
  const filename = path.basename(decodeURIComponent(parsed.pathname))
  if (!filename) return undefined
  return parsed.host === 'sessions' ? filename : path.posix.join('generated', filename)
}

/**
 * Pi types tool parameters as TypeBox but treats them as opaque schema metadata
 * at runtime, so a JSON Schema fragment passes straight through — no structural
 * conversion, and the renderer keeps emitting plain JSON Schema.
 */
export function jsonSchemaParameters(schema: Record<string, unknown>): TSchema {
  return Type.Unsafe(schema)
}

// ── Renderer tool bridge ─────────────────────────────────────────────────────

type PendingToolCall = {
  sessionId: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: PausableTimeout
  cleanupAbort?: () => void
}

const pendingToolCalls = new Map<string, PendingToolCall>()
let toolRequestCounter = 0

// Generation can legitimately take many minutes (video workflows, model
// downloads). The renderer tool has its own idle watchdog that fails stalled
// generations, so this is only a safety net against a lost IPC reply.
const TOOL_BRIDGE_TIMEOUT_MS = 30 * 60_000

/** A timeout that stops counting while paused and resumes with what was left. */
type PausableTimeout = { pause: () => void; resume: () => void }

function pausableTimeout(ms: number, onTimeout: () => void): PausableTimeout {
  let remaining = ms
  let startedAt = 0
  let timer: NodeJS.Timeout | null = null
  return {
    pause: () => {
      if (!timer) return
      clearTimeout(timer)
      timer = null
      remaining = Math.max(0, remaining - (Date.now() - startedAt))
    },
    resume: () => {
      if (timer) return
      startedAt = Date.now()
      timer = setTimeout(onTimeout, remaining)
    },
  }
}

// A session waiting on the user has no deadline, so neither have its tool calls.
onUserWaitChange((sessionId, waiting) => {
  for (const call of pendingToolCalls.values()) {
    if (call.sessionId !== sessionId) continue
    if (waiting) call.timeout.pause()
    else call.timeout.resume()
  }
})

let mainWin: BrowserWindow | null = null

export function setToolBridgeWindow(win: BrowserWindow): void {
  mainWin = win
}

/** Renderer's answer to an 'agentMode:executeTool' dispatch (via IPC). */
export function submitAgentToolResult(requestId: string, result: unknown, error?: string): void {
  const pending = pendingToolCalls.get(requestId)
  if (!pending) return
  pendingToolCalls.delete(requestId)
  pending.timeout.pause()
  pending.cleanupAbort?.()
  if (error) pending.reject(new Error(error))
  else pending.resolve(result)
}

/** Settles the renderer tool calls of one session, or of every session when none is named. */
export function rejectPendingToolCalls(reason: string, sessionId?: string): void {
  for (const [requestId, call] of [...pendingToolCalls]) {
    if (sessionId !== undefined && call.sessionId !== sessionId) continue
    pendingToolCalls.delete(requestId)
    call.timeout.pause()
    call.cleanupAbort?.()
    call.reject(new Error(reason))
  }
}

export function executeToolInRenderer(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  if (!mainWin) {
    return Promise.reject(new Error('No renderer window available for tool execution.'))
  }
  return whileRendererAnswers(sessionId, () =>
    dispatchToRenderer(sessionId, toolName, input, toolCallId, abortSignal),
  )
}

function dispatchToRenderer(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const requestId = `tool-req-${Date.now()}-${++toolRequestCounter}`
  return new Promise<unknown>((resolve, reject) => {
    const entry: PendingToolCall = {
      sessionId,
      resolve,
      reject,
      timeout: pausableTimeout(TOOL_BRIDGE_TIMEOUT_MS, () => {
        pendingToolCalls.delete(requestId)
        entry.cleanupAbort?.()
        reject(
          new Error(`Tool '${toolName}' timed out after ${TOOL_BRIDGE_TIMEOUT_MS / 60000}min.`),
        )
      }),
    }
    if (!isWaitingOnUser(sessionId)) entry.timeout.resume()
    if (abortSignal) {
      const onAbort = () => {
        // The renderer keeps running its side (no remote cancellation); its late
        // submitToolResult finds no pending entry and no-ops.
        pendingToolCalls.delete(requestId)
        entry.timeout.pause()
        reject(new Error('Tool execution aborted.'))
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      entry.cleanupAbort = () => abortSignal.removeEventListener('abort', onAbort)
    }
    pendingToolCalls.set(requestId, entry)
    // `requestId` correlates the IPC reply; `toolCallId` is the model-side id
    // the renderer's UI parts carry, so renderer-side progress (e.g. the media
    // timeline) can be attached to the right tool call while this blocks.
    if (mainWin) {
      typedSend(mainWin.webContents, 'agentMode:executeTool', {
        requestId,
        sessionId,
        toolCallId,
        toolName,
        input,
      })
    }
  })
}

/**
 * Show an image a tool produced in the conversation.
 *
 * Tool results are model context, so an image can only be put in front of the
 * USER over a side channel: the renderer merges these by tool call id and draws
 * them under the tool card, the same way it does with streamed tool output.
 * The image belongs to the open turn of the session whose tool produced it.
 */
export function sendToolImage(
  sessionId: string,
  toolCallId: string,
  dataUri: string,
  label: string,
): void {
  const turn = agentTurns.get(sessionId)
  if (!turn) return
  emitAgentToolImage(sessionId, turn.turnId, toolCallId, dataUri, label)
}

const DATA_URI_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Resolve a model-provided workspace-relative path against the workspace dir,
 * rejecting escapes and anything that is not an existing file.
 */
export function resolveWorkspaceFile(workspaceDir: string, relativePath: string): string {
  const fullPath = path.resolve(workspaceDir, relativePath)
  const relative = path.relative(workspaceDir, fullPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the workspace folder: ${relativePath}`)
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error(`File not found in workspace: ${relativePath}`)
  }
  return fullPath
}

/** Inline a workspace image file as a data URI. */
export function workspaceFileToDataUri(workspaceDir: string, relativePath: string): string {
  const fullPath = resolveWorkspaceFile(workspaceDir, relativePath)
  const mime = DATA_URI_MIME_BY_EXT[path.extname(fullPath).toLowerCase()]
  if (!mime) {
    throw new Error(`Unsupported image file type: ${relativePath}`)
  }
  return `data:${mime};base64,${fs.readFileSync(fullPath).toString('base64')}`
}

/**
 * A turn in a Session: when the workspace is its `files/` folder media lands at its root;
 * when it is a game folder media lands in the game's `generated/` and in `filesDir` too,
 * served from the Session's copy.
 */
export type SessionMediaTarget =
  | { sessionRef: string; workspace: 'files' }
  | { sessionRef: string; workspace: 'game'; filesDir: string }

let appMediaPath: ((url: string) => string | null) | null = null

/** How an app-folder media URL maps to its file, so a Session's copy can move it out. */
export function setAppMediaPathResolver(resolve: ((url: string) => string | null) | null): void {
  appMediaPath = resolve
}

const MEDIA_URL_KEYS = ['imageUrl', 'videoUrl', 'model3dUrl'] as const

async function mediaBytes(url: string): Promise<Buffer> {
  // net.fetch resolves the custom aipg-media protocol registered in
  // main.ts (including its path-traversal protection).
  const response = await net.fetch(url)
  if (!response.ok) throw new Error(`fetch failed with status ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function moveIntoSession(url: string, target: string): Promise<void> {
  const source = appMediaPath?.(url)
  if (source && fs.existsSync(source)) {
    await moveFile(source, target)
    return
  }
  fs.writeFileSync(target, await mediaBytes(url))
}

async function saveOne(
  entry: Record<string, unknown>,
  url: string,
  workspaceDir: string,
  sessionMedia: SessionMediaTarget | undefined,
): Promise<{ saved: string; sessionCopy?: string; entry: Record<string, unknown> }> {
  if (!sessionMedia) {
    const bytes = await mediaBytes(url)
    const saved =
      workspacePathForMediaUrl(url) ?? path.posix.join('generated', `media-${Date.now()}`)
    fs.mkdirSync(path.join(workspaceDir, 'generated'), { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, saved), bytes)
    return { saved, entry }
  }
  const name = path.basename(decodeURIComponent(new URL(url).pathname)) || `media-${Date.now()}`
  const filesDir = sessionMedia.workspace === 'game' ? sessionMedia.filesDir : workspaceDir
  fs.mkdirSync(filesDir, { recursive: true })
  await moveIntoSession(url, path.join(filesDir, name))
  const saved = sessionMedia.workspace === 'game' ? path.posix.join('generated', name) : name
  if (sessionMedia.workspace === 'game') {
    fs.mkdirSync(path.join(workspaceDir, 'generated'), { recursive: true })
    fs.copyFileSync(path.join(filesDir, name), path.join(workspaceDir, saved))
  }
  const key = MEDIA_URL_KEYS.find((candidate) => entry[candidate] === url) ?? 'imageUrl'
  return {
    saved,
    sessionCopy: path.join(filesDir, name),
    entry: { ...entry, [key]: sessionMediaUrl(sessionMedia.sessionRef, `files/${name}`) },
  }
}

/**
 * Save generated media (aipg-media:// URLs in the ComfyUI-shaped tool result)
 * into the workspace so Pi can reference the files, and annotate the result
 * with the workspace-relative paths: a Session's media moves to the root of its
 * `files/` folder, any other workspace gets a copy under `generated/`.
 * Non-media results and failures leave the result unchanged (the media still
 * rendered app-side).
 */
export async function saveGeneratedMediaToWorkspace(
  result: unknown,
  workspaceDir: string,
  sessionMedia?: SessionMediaTarget,
): Promise<unknown> {
  if (typeof result !== 'object' || result === null) return result
  const record = result as Record<string, unknown>
  if (!Array.isArray(record.images)) return result

  const savedFiles: string[] = []
  const sessionCopies: string[] = []
  const images: unknown[] = []
  for (const item of record.images) {
    const url =
      typeof item === 'object' && item !== null
        ? mediaUrlOf(item as Record<string, unknown>)
        : undefined
    if (typeof url !== 'string' || !url.startsWith('aipg-media://')) {
      images.push(item)
      continue
    }
    try {
      const done = await saveOne(item as Record<string, unknown>, url, workspaceDir, sessionMedia)
      savedFiles.push(done.saved)
      if (done.sessionCopy) sessionCopies.push(done.sessionCopy)
      images.push(done.entry)
    } catch (error) {
      logger.warn(`failed to save generated media to workspace: ${error}`, LOG_SOURCE)
      images.push(item)
    }
  }
  if (savedFiles.length === 0) return result
  noteGeneratedMedia(workspaceDir, savedFiles, sessionCopies)
  return {
    ...record,
    images,
    savedFiles,
    savedFilesNote:
      'The generated media files were saved into the workspace at the paths listed in savedFiles.',
  }
}

// ── Progressive-disclosure skills ────────────────────────────────────────────
//
// Pi loads skills from directories (a SKILL.md per skill, frontmatter + body)
// and puts only name + description in the system prompt until the model opens
// one. Capabilities declare their skills as sources; they are materialised into
// an app-owned skills dir per session build.

export type SkillSource = { name: string; description: string; body: string }

/** A skill as the model sees it: a description plus a file it can read. */
export type AgentSkill = {
  name: string
  description: string
  /** Path of the SKILL.md relative to the skills root. */
  relativePath: string
  /** Full SKILL.md text (frontmatter + body), for the sandbox's copy. */
  content: string
}

/**
 * Materialise the given skills under `skillsRoot` (for host-shell mode, where
 * the model reads the real files) and return them for the sandbox, which gets
 * an in-memory copy instead. Rewritten every session build so edits to the
 * capability sources ship without stale copies lingering in userData.
 */
export function writeAgentSkills(skillsRoot: string, sources: SkillSource[]): AgentSkill[] {
  const skills: AgentSkill[] = []
  for (const skill of sources) {
    const frontmatter = [
      '---',
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      '---',
      '',
    ].join('\n')
    const content = `${frontmatter}${skill.body}\n`
    try {
      const dir = path.join(skillsRoot, skill.name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content)
    } catch (error) {
      logger.warn(`failed to write skill '${skill.name}': ${error}`, LOG_SOURCE)
    }
    skills.push({
      name: skill.name,
      description: skill.description,
      relativePath: `${skill.name}/SKILL.md`,
      content,
    })
  }
  return skills
}

/**
 * The `<available_skills>` block for the system prompt, matching Pi's own
 * wording. Built here rather than handed to Pi's skill loader because the
 * location the model must read differs per mode: the sandbox sees the skills at
 * a mount point inside its virtual filesystem, not at their host path.
 */
export function buildSkillsPromptSection(skills: AgentSkill[], skillsRoot: string): string {
  if (skills.length === 0) return ''
  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    '',
    '<available_skills>',
  ]
  for (const skill of skills) {
    lines.push('  <skill>')
    lines.push(`    <name>${skill.name}</name>`)
    lines.push(`    <description>${skill.description}</description>`)
    lines.push(`    <location>${joinSkillLocation(skillsRoot, skill.relativePath)}</location>`)
    lines.push('  </skill>')
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

/** Sandbox roots are POSIX; a host root keeps the platform's separator. */
function joinSkillLocation(skillsRoot: string, relativePath: string): string {
  return skillsRoot.startsWith('/')
    ? path.posix.join(skillsRoot, relativePath)
    : path.join(skillsRoot, relativePath)
}

export const testables = { workspaceFileToDataUri }
