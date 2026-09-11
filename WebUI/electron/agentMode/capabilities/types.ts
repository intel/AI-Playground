import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SkillSource } from '../piCustomTools.ts'
import type { PlanningEnd } from '../planningPhase.ts'
import type { AgentToolSpec } from '@/types/agentIpc'

// ── Agent capabilities ───────────────────────────────────────────────────────
//
// A capability is one user-toggleable chunk of agent functionality: the media
// tools, web debugging, persistent memory, an MCP server, a skills bundle. Each
// one is expressed as a Pi extension — inline factories for our own tools (they
// need main-process state: IPC to the renderer, the MCP manager, the sandbox),
// package paths for third-party extensions Pi loads itself.
//
// This file is deliberately free of Electron imports so the resolution rules
// below can be unit-tested and reasoned about on their own.

export type CapabilityHost = {
  sessionId: string
  /** Resolved workspace folder (host path). */
  workspaceDir: string
  /** Bridged renderer tool contracts shipped with the turn. */
  toolSpecs: AgentToolSpec[]
  /** Where app-owned agent state lives ({userData}/pi/agent). */
  agentDir: string
  /** The model's context window, for the activation policy. */
  contextWindow?: number
}

/** A slash command a capability offers, runnable as a prompt of its own. */
export type CapabilityCommand = {
  /** With the leading slash, exactly as it is typed. */
  command: string
  description: string
}

export type AgentCapability = {
  id: string
  label: string
  /**
   * One line the model sees while the capability is dormant, so it knows the
   * functionality exists and can be activated.
   */
  summary: string
  /** Capability ids that must be enabled alongside this one. */
  requires?: string[]
  skills?: SkillSource[]
  /**
   * Skills that only exist at session build time — a third-party extension's
   * generated skills, for instance. Read here rather than left to the
   * extension's own `resources_discover` so they are announced at a path the
   * model can actually read in the sandbox.
   */
  buildSkills?: (host: CapabilityHost) => Promise<SkillSource[]> | SkillSource[]
  /** Slash commands the capability's extension registers, for the settings UI. */
  commands?: CapabilityCommand[]
  /** Tools the capability contributes. Skills-only capabilities omit it. */
  buildTools?: (host: CapabilityHost) => Promise<ToolDefinition[]> | ToolDefinition[]
  /** Extra extension wiring: lifecycle hooks, slash commands. */
  extend?: (pi: ExtensionAPI, host: CapabilityHost) => void
  /** Extension files of bundled packages, loaded by Pi's own extension loader. */
  extensionPaths?: (host: CapabilityHost) => string[]
  /** Non-empty when the capability cannot run right now — also shown in the UI. */
  unavailableReason?: (host: CapabilityHost) => string | undefined
  /**
   * Whether the capability may start dormant when context is tight. Off for
   * capabilities whose value is the tools being present (memory hooks) or that
   * carry no tools at all.
   */
  lazyEligible?: boolean
  /**
   * Set by a capability that *is* the session rather than an addition to it: the
   * preset's instructions replace Pi's coding-agent prompt (and the workspace,
   * skills and context-file sections with it), and the file/shell builtins are
   * cut down to `baseTools`. A preset picks such a capability; the settings list
   * does not offer it, since switching it on next to a general agent would take
   * that agent's prompt and tools away.
   *
   * `writableFiles`, when set, is the complete list of workspace-relative paths
   * the file tools may write. A capability whose output *is* one file says so
   * here rather than only asking for it in its prompt: a small model reads "put
   * everything in index.html" and still splits the code out into a second file,
   * and downstream code that was promised one file then reads the wrong one.
   */
  ownSession?: { baseTools: string[]; writableFiles?: string[] }
  /**
   * What ends the thinking phase of a session running this capability, for users
   * who asked to think during planning only. Absent means the capability has no
   * plan step of its own. See planningPhase.ts.
   */
  planningEnd?: PlanningEnd
  /**
   * Splits the first turn into planning and building: the model is asked for a
   * plan alone, and the harness then sends this prompt itself — the approval,
   * granted automatically — so the build is a second request, made with thinking
   * already off. For a capability whose whole job otherwise fits in one reply,
   * where there is no later step left for a thinking switch to make cheaper.
   */
  planHandoff?: string
}

/** True when this capability defines the shape of the whole session, not an add-on. */
export function shapesSession(capability: AgentCapability): boolean {
  return !!(capability.ownSession || capability.planningEnd || capability.planHandoff)
}

/** A capability plus what it contributed to this session. */
export type ResolvedCapability = {
  capability: AgentCapability
  tools: ToolDefinition[]
  /** Declared skills plus whatever `buildSkills` found on disk. */
  skills: SkillSource[]
}

/**
 * Add every required capability of every requested capability, keeping the
 * catalog's order and dropping ids the catalog does not know. Requirements are
 * followed transitively, so `game-studio` pulling in `media` which pulls in
 * something else still resolves in one pass.
 */
export function expandCapabilityIds(
  catalog: AgentCapability[],
  requested: readonly string[],
): string[] {
  const byId = new Map(catalog.map((capability) => [capability.id, capability]))
  const wanted = new Set<string>()
  const queue = [...requested]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (wanted.has(id)) continue
    const capability = byId.get(id)
    if (!capability) continue
    wanted.add(id)
    queue.push(...(capability.requires ?? []))
  }
  return catalog.filter((capability) => wanted.has(capability.id)).map(({ id }) => id)
}

/**
 * Rough token cost of exposing these tools to the model. Tool schemas are
 * rendered as JSON, and ~4 characters per token is the usual approximation —
 * good enough to decide whether a tool set is a rounding error or a big chunk
 * of a small context window.
 */
export function estimateToolTokens(tools: readonly ToolDefinition[]): number {
  let characters = 0
  for (const tool of tools) {
    characters += tool.name.length + (tool.description?.length ?? 0)
    try {
      characters += JSON.stringify(tool.parameters ?? {}).length
    } catch {
      // A schema that cannot be serialized cannot be sent to the model either;
      // the session build surfaces that on its own.
    }
  }
  return Math.ceil(characters / 4)
}

/**
 * Share of the context window that capability tool schemas may occupy before
 * they start being kept dormant. On a local llama.cpp model, deferring tools is
 * a latency LOSS (activation invalidates the whole prompt cache and re-processes
 * the conversation), so the only reason to defer is running out of room.
 */
export const LAZY_ACTIVATION_BUDGET = 0.25

/**
 * Whether capability tools should start dormant. Eager is the default and the
 * fast path; a small context window is the exception that justifies paying an
 * activation later.
 */
export function shouldDeferCapabilityTools(options: {
  contextWindow?: number
  capabilityToolTokens: number
}): boolean {
  const { contextWindow, capabilityToolTokens } = options
  if (!contextWindow || contextWindow <= 0) return false
  return capabilityToolTokens > contextWindow * LAZY_ACTIVATION_BUDGET
}
