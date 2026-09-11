import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, net } from 'electron'
import { Type, type TSchema } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../logging/logger.ts'

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
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  cleanupAbort?: () => void
}

const pendingToolCalls = new Map<string, PendingToolCall>()
let toolRequestCounter = 0

// Generation can legitimately take many minutes (video workflows, model
// downloads). The renderer tool has its own idle watchdog that fails stalled
// generations, so this is only a safety net against a lost IPC reply.
const TOOL_BRIDGE_TIMEOUT_MS = 30 * 60_000

let mainWin: BrowserWindow | null = null

export function setToolBridgeWindow(win: BrowserWindow): void {
  mainWin = win
}

/** Renderer's answer to an 'agentMode:executeTool' dispatch (via IPC). */
export function submitAgentToolResult(requestId: string, result: unknown, error?: string): void {
  const pending = pendingToolCalls.get(requestId)
  if (!pending) return
  pendingToolCalls.delete(requestId)
  clearTimeout(pending.timeout)
  pending.cleanupAbort?.()
  if (error) pending.reject(new Error(error))
  else pending.resolve(result)
}

export function rejectAllPendingToolCalls(reason: string): void {
  const pending = [...pendingToolCalls.values()]
  pendingToolCalls.clear()
  for (const call of pending) {
    clearTimeout(call.timeout)
    call.cleanupAbort?.()
    call.reject(new Error(reason))
  }
}

export function executeToolInRenderer(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  if (!mainWin) {
    return Promise.reject(new Error('No renderer window available for tool execution.'))
  }
  const requestId = `tool-req-${Date.now()}-${++toolRequestCounter}`
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingToolCalls.delete(requestId)
      reject(new Error(`Tool '${toolName}' timed out after ${TOOL_BRIDGE_TIMEOUT_MS / 60000}min.`))
    }, TOOL_BRIDGE_TIMEOUT_MS)
    const entry: PendingToolCall = { resolve, reject, timeout }
    if (abortSignal) {
      const onAbort = () => {
        // The renderer keeps running its side (no remote cancellation); its late
        // submitToolResult finds no pending entry and no-ops.
        pendingToolCalls.delete(requestId)
        clearTimeout(timeout)
        reject(new Error('Tool execution aborted.'))
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      entry.cleanupAbort = () => abortSignal.removeEventListener('abort', onAbort)
    }
    pendingToolCalls.set(requestId, entry)
    // `requestId` correlates the IPC reply; `toolCallId` is the model-side id
    // the renderer's UI parts carry, so renderer-side progress (e.g. the media
    // timeline) can be attached to the right tool call while this blocks.
    mainWin?.webContents.send('agentMode:executeTool', {
      requestId,
      toolCallId,
      toolName,
      input,
    })
  })
}

/**
 * Show an image a tool produced in the conversation.
 *
 * Tool results are model context, so an image can only be put in front of the
 * USER over a side channel: the renderer merges these by tool call id and draws
 * them under the tool card, the same way it does with streamed tool output.
 */
export function sendToolImage(toolCallId: string, dataUri: string, label: string): void {
  mainWin?.webContents.send('agentMode:toolImage', { toolCallId, dataUri, label })
}

const DATA_URI_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Resolve a model-provided workspace-relative path against the (realpathed)
 * workspace dir, rejecting escapes, and inline the file as a data URI.
 */
export function workspaceFileToDataUri(workspaceDir: string, relativePath: string): string {
  const fullPath = path.resolve(workspaceDir, relativePath)
  const relative = path.relative(workspaceDir, fullPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the workspace folder: ${relativePath}`)
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error(`File not found in workspace: ${relativePath}`)
  }
  const mime = DATA_URI_MIME_BY_EXT[path.extname(fullPath).toLowerCase()]
  if (!mime) {
    throw new Error(`Unsupported image file type: ${relativePath}`)
  }
  return `data:${mime};base64,${fs.readFileSync(fullPath).toString('base64')}`
}

/**
 * Copy generated media (aipg-media:// URLs in the ComfyUI-shaped tool result)
 * into `<workspace>/generated/` so Pi can reference the files, and annotate
 * the result with the workspace-relative paths. Non-media results and fetch
 * failures leave the result unchanged (the media still rendered app-side).
 */
export async function saveGeneratedMediaToWorkspace(
  result: unknown,
  workspaceDir: string,
): Promise<unknown> {
  if (typeof result !== 'object' || result === null) return result
  const record = result as Record<string, unknown>
  if (!Array.isArray(record.images)) return result

  const savedFiles: string[] = []
  for (const item of record.images) {
    if (typeof item !== 'object' || item === null) continue
    const media = item as Record<string, unknown>
    const url = media.imageUrl ?? media.videoUrl ?? media.model3dUrl
    if (typeof url !== 'string' || !url.startsWith('aipg-media://')) continue
    try {
      // net.fetch resolves the custom aipg-media protocol registered in
      // main.ts (including its path-traversal protection).
      const response = await net.fetch(url)
      if (!response.ok) throw new Error(`fetch failed with status ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      const generatedDir = path.join(workspaceDir, 'generated')
      fs.mkdirSync(generatedDir, { recursive: true })
      const filename =
        path.basename(decodeURIComponent(new URL(url).pathname)) || `media-${Date.now()}`
      fs.writeFileSync(path.join(generatedDir, filename), bytes)
      savedFiles.push(path.posix.join('generated', filename))
    } catch (error) {
      logger.warn(`failed to save generated media to workspace: ${error}`, LOG_SOURCE)
    }
  }
  if (savedFiles.length === 0) return result
  return {
    ...record,
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
