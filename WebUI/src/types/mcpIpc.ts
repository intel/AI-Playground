/**
 * MCP registry IPC (`mcp:*` channels): the mcp.json config shape and the
 * runtime registry state main keeps in `electron/adapters/mcp/`. Tool bodies
 * for chat turns run in main (`chatMcpTool.ts`); these channels drive the
 * settings surface.
 */

export type McpConnectionState = 'stopped' | 'starting' | 'running' | 'error'

export type McpStatus = {
  state: McpConnectionState
  lastError?: string
}

export type McpToolInfo = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export type McpServerInfo = {
  id: string
  name: string
  instructions?: string
  /** UI-facing help text (what the server is for / how to use it), shown as an info
   *  tooltip in settings. Distinct from `instructions`, which is fed to the model. */
  description?: string
}

export type McpToolCallResult = {
  isError?: boolean
  content?: unknown
  structuredContent?: unknown
}

export type McpServerConfig =
  | {
      type?: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
      displayName?: string
      instructions?: string
      description?: string
    }
  | {
      type: 'http'
      url: string
      headers?: Record<string, string>
      displayName?: string
      instructions?: string
      description?: string
    }
