import { asSchema, type ToolSet } from 'ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../../logging/logger.ts'
import { getMcpServerTools } from '../../subprocesses/mcpManager.ts'
import { jsonResult, jsonSchemaParameters } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentCapability } from './types.ts'
import { mcpCapabilityId } from '@/types/agentCapabilities'

export { MCP_CAPABILITY_PREFIX, mcpCapabilityId, mcpServerIdOf } from '@/types/agentCapabilities'

// ── MCP capabilities ─────────────────────────────────────────────────────────
//
// One capability per configured MCP server (`mcp:<serverId>`), since Pi has no
// MCP client of its own and the app already has one. Servers are started on
// demand by mcpManager, which also owns their lifetime (shared with the app's
// MCP UI, stopped on app quit), so nothing is closed on session teardown.

const logger = appLoggerInstance
const LOG_SOURCE = 'capabilities/mcp'

async function buildMcpTools(serverId: string): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  let tools: ToolSet
  try {
    tools = await getMcpServerTools(serverId)
  } catch (error) {
    // A broken MCP config must not take down the whole agent turn.
    logger.warn(`failed to attach MCP server '${serverId}': ${error}`, LOG_SOURCE)
    return []
  }
  const definitions: ToolDefinition[] = []
  for (const [name, mcpTool] of Object.entries(tools)) {
    const execute = mcpTool.execute
    if (!execute) continue
    const inputSchema = asSchema(mcpTool.inputSchema).jsonSchema as Record<string, unknown>
    // MCP tool descriptions are plain strings; the AI SDK type also allows a
    // context-dependent function, which MCP never produces.
    const description =
      typeof mcpTool.description === 'string'
        ? mcpTool.description
        : `MCP tool ${name} from ${serverId}`
    definitions.push(
      pi.defineTool({
        name,
        label: name,
        description,
        parameters: jsonSchemaParameters(inputSchema),
        execute: async (toolCallId, params, signal) => {
          const result = await execute(params, {
            toolCallId,
            messages: [],
            context: undefined,
            ...(signal ? { abortSignal: signal } : {}),
          })
          return jsonResult(result)
        },
      }) as ToolDefinition,
    )
  }
  logger.info(`attached ${definitions.length} MCP tool(s) from '${serverId}'`, LOG_SOURCE)
  return definitions
}

/** The capability record for one configured MCP server. */
export function mcpCapability(serverId: string): AgentCapability {
  return {
    id: mcpCapabilityId(serverId),
    label: `MCP: ${serverId}`,
    summary: `Tools from the '${serverId}' MCP server.`,
    buildTools: () => buildMcpTools(serverId),
    lazyEligible: true,
  }
}
