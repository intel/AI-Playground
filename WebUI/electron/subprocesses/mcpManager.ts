import path from 'node:path'
import type { ToolSet } from 'ai'
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import { appLoggerInstance } from '../logging/logger'
import { loadMcpServers, type McpServerConfig } from './mcpServers'
import { uvPath } from './uvBasedBackends/uv'

type HttpTransportConfig = {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

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

const UV_COMMANDS = new Set(['uv', 'uv.exe'])
const UVX_COMMANDS = new Set(['uvx', 'uvx.exe'])

function resolveStdioCommand(
  command: string,
  args: string[] = [],
): { command: string; args: string[] } {
  const basename = path.basename(command).toLowerCase()
  if (UV_COMMANDS.has(basename)) {
    return { command: uvPath, args }
  }
  if (UVX_COMMANDS.has(basename)) {
    return { command: uvPath, args: ['tool', 'run', ...args] }
  }
  return { command, args }
}

const clients = new Map<string, MCPClient>()
const statuses = new Map<string, McpStatus>()
const pendingStarts = new Map<string, Promise<McpStatus>>()

function ensureStatus(serverId: string) {
  if (!statuses.has(serverId)) {
    statuses.set(serverId, { state: 'stopped' })
  }
}

function getServerConfig(serverId: string): McpServerConfig {
  const servers = loadMcpServers()
  const config = servers[serverId]
  if (!config) {
    throw new Error(`Unknown MCP server id: ${serverId}`)
  }
  return config
}

export function listMcpServers(): McpServerInfo[] {
  const servers = loadMcpServers()
  return Object.entries(servers).map(([id, server]) => ({
    id,
    name: server.displayName ?? id,
    instructions: server.instructions,
    description: server.description,
  }))
}

function setStatus(serverId: string, next: McpStatus) {
  statuses.set(serverId, next)
}

export function getMcpServerStatus(serverId: string): McpStatus {
  ensureStatus(serverId)
  return statuses.get(serverId) ?? { state: 'stopped' }
}

export async function startMcpServer(serverId: string): Promise<McpStatus> {
  ensureStatus(serverId)

  if (clients.has(serverId)) {
    return getMcpServerStatus(serverId)
  }

  const existingStart = pendingStarts.get(serverId)
  if (existingStart) {
    return existingStart
  }

  const startPromise = (async (): Promise<McpStatus> => {
    try {
      const config = getServerConfig(serverId)
      setStatus(serverId, { state: 'starting' })

      try {
        let transport: HttpTransportConfig | Experimental_StdioMCPTransport

        if ('command' in config) {
          const mergedEnv = {
            ...process.env,
            ...(config.env ?? {}),
          }
          const stdioEnv = Object.fromEntries(
            Object.entries(mergedEnv).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )

          const resolved = resolveStdioCommand(config.command, config.args)

          transport = new Experimental_StdioMCPTransport({
            command: resolved.command,
            args: resolved.args,
            env: stdioEnv,
          })
        } else if ('url' in config) {
          transport = {
            type: 'http',
            url: config.url,
            headers: config.headers,
          }
        } else {
          throw new Error('Invalid MCP server config: missing command (stdio) or url (http)')
        }

        const client = await createMCPClient({
          transport,
          name: `ai-playground-${serverId}-mcp-client`,
          version: '1.0.0',
        })

        clients.set(serverId, client)
        setStatus(serverId, { state: 'running' })
        appLoggerInstance.info(`MCP server started: ${serverId}`, 'mcp')
        return getMcpServerStatus(serverId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setStatus(serverId, { state: 'error', lastError: message })
        appLoggerInstance.error(`Failed to start MCP server ${serverId}: ${message}`, 'mcp')
        return getMcpServerStatus(serverId)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus(serverId, { state: 'error', lastError: message })
      appLoggerInstance.error(`Failed to start MCP server ${serverId}: ${message}`, 'mcp')
      return getMcpServerStatus(serverId)
    }
  })()

  pendingStarts.set(serverId, startPromise)
  const clearPendingStart = () => pendingStarts.delete(serverId)
  startPromise.then(clearPendingStart, clearPendingStart)
  return startPromise
}

export async function stopMcpServer(serverId: string): Promise<McpStatus> {
  ensureStatus(serverId)
  const client = clients.get(serverId)

  if (!client) {
    setStatus(serverId, { state: 'stopped' })
    return getMcpServerStatus(serverId)
  }

  try {
    await client.close()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appLoggerInstance.warn(`Error while stopping MCP server ${serverId}: ${message}`, 'mcp')
  } finally {
    clients.delete(serverId)
    setStatus(serverId, { state: 'stopped' })
  }

  appLoggerInstance.info(`MCP server stopped: ${serverId}`, 'mcp')
  return getMcpServerStatus(serverId)
}

// A nextCursor that never clears would retain every page in the main process.
export const MAX_MCP_TOOL_LIST_PAGES = 50
export const MAX_MCP_TOOL_LIST_TOOLS = 500
// Per page, so a server that accepts the request and never answers cannot stall the loop.
export const MCP_TOOL_LIST_PAGE_TIMEOUT_MS = 15_000

type McpToolListPage<T> = {
  tools: readonly T[]
  nextCursor?: string | null
}

function withPageDeadline<T>(
  serverId: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `Tool list for ${serverId} timed out after ${MCP_TOOL_LIST_PAGE_TIMEOUT_MS}ms`,
      )
      controller.abort(error)
      reject(error)
    }, MCP_TOOL_LIST_PAGE_TIMEOUT_MS)
  })

  let page: Promise<T>
  try {
    page = Promise.resolve(run(controller.signal))
  } catch (error) {
    clearTimeout(timer)
    return Promise.reject(error)
  }
  // The aborted request rejects on its own; handle it so that rejection is not unhandled.
  void page.catch(() => undefined)
  return Promise.race([page, timeout]).finally(() => {
    clearTimeout(timer)
  })
}

export async function collectMcpToolPages<T>(
  serverId: string,
  listPage: (cursor: string | undefined, signal: AbortSignal) => Promise<McpToolListPage<T>>,
): Promise<T[]> {
  const allTools: T[] = []
  let cursor: string | undefined
  let pages = 0

  do {
    if (++pages > MAX_MCP_TOOL_LIST_PAGES) {
      appLoggerInstance.warn(
        `Tool list for ${serverId} truncated after ${MAX_MCP_TOOL_LIST_PAGES} pages`,
        'mcp',
      )
      break
    }

    const { tools, nextCursor } = await withPageDeadline(serverId, (signal) =>
      listPage(cursor, signal),
    )
    if (!Array.isArray(tools)) {
      throw new Error(`Tool list for ${serverId} returned a malformed page`)
    }

    const room = MAX_MCP_TOOL_LIST_TOOLS - allTools.length
    const kept = tools.slice(0, room)
    allTools.push(...kept)
    const next = typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : undefined
    if (allTools.length >= MAX_MCP_TOOL_LIST_TOOLS) {
      if (kept.length < tools.length || next) {
        appLoggerInstance.warn(
          `Tool list for ${serverId} truncated at ${MAX_MCP_TOOL_LIST_TOOLS} tools`,
          'mcp',
        )
      }
      break
    }
    cursor = next
  } while (cursor)

  return allTools
}

export function listClientTools(serverId: string, client: { listTools: MCPClient['listTools'] }) {
  return collectMcpToolPages(serverId, (cursor, signal) =>
    client.listTools({
      params: { cursor },
      options: { signal, timeout: MCP_TOOL_LIST_PAGE_TIMEOUT_MS },
    }),
  )
}

export async function listMcpServerTools(serverId: string): Promise<McpToolInfo[]> {
  const client = clients.get(serverId)
  if (!client || getMcpServerStatus(serverId).state !== 'running') {
    return []
  }

  try {
    const tools = await listClientTools(serverId, client)
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setStatus(serverId, { state: 'error', lastError: message })
    appLoggerInstance.error(`Failed to list MCP tools for ${serverId}: ${message}`, 'mcp')
    return []
  }
}

export async function invokeMcpServerTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const client = clients.get(serverId)
  if (!client || getMcpServerStatus(serverId).state !== 'running') {
    return {
      isError: true,
      content: [{ type: 'text', text: `MCP server ${serverId} is not running` }],
    }
  }

  try {
    const tools = client.toolsFromDefinitions({ tools: await listClientTools(serverId, client) })
    const targetTool = tools[toolName]

    if (!targetTool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `MCP tool not found: ${toolName}` }],
      }
    }

    // MCP tools are AI SDK tools, execute through the AI SDK contract.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (targetTool.execute as any)?.(args, {
      toolCallId: `mcp-${Date.now()}`,
      messages: [],
    })

    return {
      isError: false,
      structuredContent: result,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appLoggerInstance.error(`Failed to call MCP tool ${toolName} on ${serverId}: ${message}`, 'mcp')
    return {
      isError: true,
      content: [{ type: 'text', text: `Failed to call MCP tool ${toolName}: ${message}` }],
    }
  }
}

/**
 * Start (if needed) an MCP server and return its tools as an AI SDK `ToolSet`,
 * ready to hand to `streamText`/`HarnessAgent`. Each tool's `execute()` runs
 * the call over the live MCP connection in this process — the same contract
 * `invokeMcpServerTool` uses. Throws if the server can't be brought to
 * `running` so callers can decide whether to proceed without it.
 */
export async function getMcpServerTools(serverId: string): Promise<ToolSet> {
  const status = await startMcpServer(serverId)
  if (status.state !== 'running') {
    throw new Error(status.lastError ?? `MCP server ${serverId} failed to start`)
  }
  const client = clients.get(serverId)
  if (!client) {
    throw new Error(`MCP server ${serverId} has no active client`)
  }
  return client.toolsFromDefinitions({ tools: await listClientTools(serverId, client) })
}

export async function stopAllMcpServers(): Promise<void> {
  const serverIds = [...clients.keys()]
  await Promise.all(serverIds.map((serverId) => stopMcpServer(serverId)))
}
