import { invokeMcpServerTool, listMcpServers } from '../adapters/mcp/mcpManager'
import { trackChatToolActivity } from './chatToolActivity'

// ── Chat MCP tools, in main (docs/architecture-target.md §8) ────────────────
//
// The client lives here (`mcpManager`), so a chat MCP call used to be a double
// hop: main → renderer → `mcp:invokeServerTool` → main. Agent Mode already
// invokes the manager in-process (`agent/capabilities/mcp.ts`); this is the
// same cut for Chat. The tool name carries the routing, the way the renderer
// minted it: `mcp__<serverId>__<toolName>`.

export const MCP_TOOL_PREFIX = 'mcp__'

export function isChatMcpTool(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX)
}

/**
 * A server id may itself contain `__`, so the split is resolved against the
 * configured servers and only falls back to the first separator.
 */
export function parseMcpToolName(
  toolName: string,
  serverIds: string[],
): { serverId: string; toolName: string } | null {
  if (!isChatMcpTool(toolName)) return null
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  for (const serverId of serverIds) {
    const prefix = `${serverId}__`
    if (rest.startsWith(prefix) && rest.length > prefix.length) {
      return { serverId, toolName: rest.slice(prefix.length) }
    }
  }
  const separator = rest.indexOf('__')
  if (separator <= 0 || separator + 2 >= rest.length) return null
  return { serverId: rest.slice(0, separator), toolName: rest.slice(separator + 2) }
}

export async function executeChatMcpTool(options: {
  toolName: string
  input: unknown
  conversationKey?: string
}): Promise<unknown> {
  const parsed = parseMcpToolName(
    options.toolName,
    listMcpServers().map((server) => server.id),
  )
  if (!parsed) throw new Error(`Malformed MCP tool name: ${options.toolName}`)
  return await trackChatToolActivity(
    {
      category: 'tools',
      label: `Running ${parsed.toolName}…`,
      conversationKey: options.conversationKey,
    },
    () =>
      invokeMcpServerTool(
        parsed.serverId,
        parsed.toolName,
        (options.input ?? {}) as Record<string, unknown>,
      ),
  )
}
