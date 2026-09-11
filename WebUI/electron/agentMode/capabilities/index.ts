import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../../logging/logger.ts'
import type { SkillSource } from '../piCustomTools.ts'
import { createCapabilitiesExtension } from './core.ts'
import { gameStudioCapability, gameStudioQuickCapability } from './gameStudio.ts'
import { mediaCapability } from './media.ts'
import { mcpCapability, mcpCapabilityId, mcpServerIdOf } from './mcp.ts'
import { memoryCapability } from './memory.ts'
import { webDebugCapability } from './webDebug.ts'
import type { PlanningEnd } from '../planningPhase.ts'
import {
  estimateToolTokens,
  expandCapabilityIds,
  shouldDeferCapabilityTools,
  shapesSession,
  type AgentCapability,
  type CapabilityCommand,
  type CapabilityHost,
  type ResolvedCapability,
} from './types.ts'

// ── Capability registry ──────────────────────────────────────────────────────
//
// Turns the capability ids the user enabled for a session into everything the Pi
// session needs: inline extension factories (our own tools), extension paths
// (bundled Pi packages), skills to materialise, and the set of tools that is
// active from the first request.
//
// Everything a capability contributes goes through Pi's extension system rather
// than `customTools`, so capabilities also get lifecycle hooks and slash
// commands. The file/shell builtins stay outside this (piToolOperations.ts):
// they are not optional and not user-facing.

const logger = appLoggerInstance
const LOG_SOURCE = 'capabilities'

/** Capabilities that are enabled for a new session unless the user says otherwise. */
export { DEFAULT_CAPABILITY_IDS } from '@/types/agentCapabilities'

/** Built-in capabilities, in the order their tools are registered. */
const BUILT_IN_CAPABILITIES: AgentCapability[] = [
  webDebugCapability,
  mediaCapability,
  memoryCapability,
  gameStudioCapability,
  gameStudioQuickCapability,
]

/**
 * The capabilities on offer for this session. MCP servers are dynamic — one
 * capability per configured server — so requested `mcp:<id>` ids are folded in.
 */
export function capabilityCatalog(requestedIds: readonly string[] = []): AgentCapability[] {
  const mcpIds = requestedIds
    .map((id) => mcpServerIdOf(id))
    .filter((serverId): serverId is string => !!serverId)
  // MCP first: a later registration wins on a name clash, so an MCP server
  // cannot shadow a built-in tool like `media`.
  return [...new Set(mcpIds)]
    .map((serverId) => mcpCapability(serverId))
    .concat(BUILT_IN_CAPABILITIES)
}

export type CapabilityResolution = {
  /** Capabilities contributing to this session, requirements included. */
  resolved: ResolvedCapability[]
  extensionFactories: ExtensionFactory[]
  extensionPaths: string[]
  /** Skills to materialise: every enabled capability's, dormant ones included. */
  skillSources: SkillSource[]
  /** Skill names to announce in the system prompt (dormant ones stay quiet). */
  announcedSkillNames: string[]
  /** Tool names to hide until the `capabilities` tool activates them. */
  dormantToolNames: string[]
  /** Capability ids whose tools wait for the `capabilities` tool to load them. */
  dormantIds: string[]
  /** Prompt text for the dormant capabilities, '' when everything is eager. */
  dormantPromptSection: string
  /**
   * Set when one of the capabilities owns the session: the preset's instructions
   * are the whole system prompt and the builtin toolbox is cut to these tools
   * (see `AgentCapability.ownSession`).
   */
  ownSession?: { baseTools: string[]; writableFiles?: string[] }
  /** How this session's planning phase ends, when a capability defines one. */
  planningEnd?: PlanningEnd
  /** The build request sent after the plan, for a session that plans first. */
  planHandoff?: string
}

/**
 * Build the session's capabilities. Tools are built up front (they are needed to
 * size the tool set against the context window), then handed to a per-capability
 * extension factory that registers them with Pi.
 */
export async function resolveCapabilities(
  host: CapabilityHost,
  enabledIds: readonly string[],
): Promise<CapabilityResolution> {
  const catalog = capabilityCatalog(enabledIds)
  const wantedIds = expandCapabilityIds(catalog, enabledIds)
  const byId = new Map(catalog.map((capability) => [capability.id, capability]))

  const resolved: ResolvedCapability[] = []
  for (const id of wantedIds) {
    const capability = byId.get(id)
    if (!capability) continue
    const reason = capability.unavailableReason?.(host)
    if (reason) {
      logger.info(`capability '${id}' unavailable: ${reason}`, LOG_SOURCE)
      continue
    }
    let tools: ToolDefinition[] = []
    let builtSkills: SkillSource[] = []
    try {
      tools = (await capability.buildTools?.(host)) ?? []
      builtSkills = (await capability.buildSkills?.(host)) ?? []
    } catch (error) {
      // One broken capability must not cost the user the whole turn.
      logger.warn(`capability '${id}' failed to build: ${error}`, LOG_SOURCE)
      continue
    }
    resolved.push({ capability, tools, skills: [...(capability.skills ?? []), ...builtSkills] })
  }

  const capabilityToolTokens = estimateToolTokens(resolved.flatMap((entry) => entry.tools))
  const defer = shouldDeferCapabilityTools({
    contextWindow: host.contextWindow,
    capabilityToolTokens,
  })
  const dormant = defer
    ? resolved.filter((entry) => entry.capability.lazyEligible && entry.tools.length > 0)
    : []
  const dormantIds = new Set(dormant.map((entry) => entry.capability.id))

  const extensionFactories: ExtensionFactory[] = resolved.map(({ capability, tools }) => {
    return (pi) => {
      for (const tool of tools) pi.registerTool(tool)
      capability.extend?.(pi, host)
    }
  })
  const extensionPaths = resolved.flatMap(
    ({ capability }) => capability.extensionPaths?.(host) ?? [],
  )

  const dormantToolNames = [
    ...new Set(dormant.flatMap(({ tools }) => tools.map((tool) => tool.name))),
  ]

  let dormantPromptSection = ''
  if (dormant.length > 0) {
    const skillLocations = Object.fromEntries(
      dormant.map(({ capability, skills }) => [
        capability.id,
        skills.map((skill) => `${skill.name}/SKILL.md`),
      ]),
    )
    const core = createCapabilitiesExtension({ resolved, dormant, skillLocations })
    extensionFactories.push(core.factory)
    dormantPromptSection = core.promptSection
    logger.info(
      `capability tools (~${capabilityToolTokens} tokens) exceed the context budget; ` +
        `keeping ${[...dormantIds].join(', ')} dormant`,
      LOG_SOURCE,
    )
  }

  // A session has one shape. Two capabilities that each define one used to
  // silently first-wins; fail the build instead so a mixed preset is visible.
  const shapers = resolved.filter(({ capability }) => shapesSession(capability))
  if (shapers.length > 1) {
    throw new Error(
      `Capabilities ${shapers.map(({ capability }) => capability.id).join(', ')} all shape the session; enable only one of them.`,
    )
  }
  const ownSession = shapers[0]?.capability.ownSession
  const planningEnd = shapers[0]?.capability.planningEnd
  const planHandoff = shapers[0]?.capability.planHandoff

  return {
    resolved,
    extensionFactories,
    extensionPaths,
    ...(ownSession ? { ownSession } : {}),
    ...(planningEnd ? { planningEnd } : {}),
    ...(planHandoff ? { planHandoff } : {}),
    skillSources: resolved.flatMap(({ skills }) => skills),
    announcedSkillNames: resolved
      .filter(({ capability }) => !dormantIds.has(capability.id))
      .flatMap(({ skills }) => skills.map((skill) => skill.name)),
    dormantToolNames,
    dormantIds: [...dormantIds],
    dormantPromptSection,
  }
}

export { CAPABILITIES_TOOL_NAME } from './core.ts'
export { mcpCapabilityId, mcpServerIdOf, MCP_CAPABILITY_PREFIX } from './mcp.ts'

/**
 * Capability metadata for the settings UI: what exists, what it does, and why
 * something cannot be used right now. Same catalog the session build uses, so
 * the checkbox list can never drift from what the agent actually gets — minus
 * the capabilities that shape the session (`ownSession`, `planningEnd`,
 * `planHandoff`), which belong to their preset rather than to a checkbox next
 * to another preset's agent.
 */
export type CapabilityInfo = {
  id: string
  label: string
  summary: string
  requires: string[]
  /** Slash commands the capability answers, runnable straight from settings. */
  commands: CapabilityCommand[]
  unavailableReason?: string
}

export function listCapabilities(
  host: CapabilityHost,
  mcpServerIds: string[] = [],
): CapabilityInfo[] {
  return capabilityCatalog(mcpServerIds.map((id) => mcpCapabilityId(id)))
    .filter((capability) => !shapesSession(capability))
    .map((capability) => {
      const reason = capability.unavailableReason?.(host)
      return {
        id: capability.id,
        label: capability.label,
        summary: capability.summary,
        requires: capability.requires ?? [],
        commands: capability.commands ?? [],
        ...(reason ? { unavailableReason: reason } : {}),
      }
    })
}

export type {
  AgentCapability,
  CapabilityCommand,
  CapabilityHost,
  ResolvedCapability,
} from './types.ts'
export { shapesSession } from './types.ts'
