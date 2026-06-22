import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { appLoggerInstance } from '../logging/logger'
import { packagedResourcesRoot } from '../aipgRoot.ts'

export type McpServerConfig =
  | {
      type?: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
      displayName?: string
      instructions?: string
    }
  | {
      type: 'http'
      url: string
      headers?: Record<string, string>
      displayName?: string
      instructions?: string
    }

type McpConfigFile = {
  mcpServers: Record<string, McpServerConfig>
}

function getExternalResourcesDir(): string {
  return path.resolve(
    app.isPackaged ? packagedResourcesRoot() : path.join(__dirname, '../../external/'),
  )
}

export function getMcpConfigPath(): string {
  const externalRes = getExternalResourcesDir()
  return path.join(externalRes, app.isPackaged ? 'mcp.json' : 'mcp-dev.json')
}

export function loadMcpServers(): Record<string, McpServerConfig> {
  const configPath = getMcpConfigPath()

  if (!fs.existsSync(configPath)) {
    throw new Error(`MCP config file not found: ${configPath}`)
  }

  const content = fs.readFileSync(configPath, 'utf-8')

  let config: McpConfigFile
  try {
    config = JSON.parse(content) as McpConfigFile
  } catch (error) {
    throw new Error(
      `Failed to parse MCP config file: ${configPath}. ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    throw new Error(
      `Invalid MCP config file: ${configPath}. Missing or invalid 'mcpServers' field.`,
    )
  }

  appLoggerInstance.info(`Loaded MCP servers from ${configPath}`, 'mcp')
  return config.mcpServers
}

export function addMcpServer(serverId: string, config: McpServerConfig): void {
  const configPath = getMcpConfigPath()
  // Create a new mcp.json as needed, so users don't get stuck in the UI
  const servers = fs.existsSync(configPath) ? loadMcpServers() : {}

  if (servers[serverId]) {
    throw new Error(`MCP server with ID "${serverId}" already exists`)
  }

  servers[serverId] = config

  const newConfig: McpConfigFile = { mcpServers: servers }
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf-8')

  appLoggerInstance.info(`Added MCP server: ${serverId}`, 'mcp')
}

export function getMcpServerConfig(serverId: string): McpServerConfig {
  const servers = loadMcpServers()

  if (!servers[serverId]) {
    throw new Error(`MCP server with ID "${serverId}" not found`)
  }

  appLoggerInstance.info(`Retrieved MCP server config: ${serverId}`, 'mcp')
  return servers[serverId]
}

export function updateMcpServer(serverId: string, config: McpServerConfig): void {
  const configPath = getMcpConfigPath()
  const servers = loadMcpServers()

  if (!servers[serverId]) {
    throw new Error(`MCP server with ID "${serverId}" not found`)
  }

  servers[serverId] = config

  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8')

  appLoggerInstance.info(`Updated MCP server: ${serverId}`, 'mcp')
}

export function removeMcpServer(serverId: string): void {
  const configPath = getMcpConfigPath()
  const servers = loadMcpServers()

  if (!servers[serverId]) {
    throw new Error(`MCP server with ID "${serverId}" not found`)
  }

  delete servers[serverId]

  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8')

  appLoggerInstance.info(`Removed MCP server: ${serverId}`, 'mcp')
}

type AutoDetectRule = {
  id: string
  ownsCommand: (command: string) => boolean
  match: () => McpServerConfig | null
}

const ACER_PREFIX = 'AcerIncorporated.AcerMCPService'
const ACER_APP_PATHS_KEY =
  'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AcerMCPService.exe'

function readRegistryDefaultString(hive: 'HKCU' | 'HKLM', subKey: string): string | null {
  try {
    const stdout = execFileSync('reg.exe', ['query', `${hive}\\${subKey}`, '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const match = stdout.match(/^\s*\(Default\)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/m)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

const AUTO_DETECT_RULES: AutoDetectRule[] = [
  {
    id: 'acer-mcp-server',
    ownsCommand: (command) =>
      command.toLowerCase().includes(`\\windowsapps\\${ACER_PREFIX.toLowerCase()}`),
    match: () => {
      if (process.platform !== 'win32') return null
      const exe =
        readRegistryDefaultString('HKCU', ACER_APP_PATHS_KEY) ??
        readRegistryDefaultString('HKLM', ACER_APP_PATHS_KEY)
      if (!exe) return null
      if (!fs.existsSync(exe)) return null
      return { type: 'stdio', displayName: 'Acer MCP', command: exe }
    },
  },
]

export type AutoDetectChange = { id: string; action: 'added' | 'refreshed' }

export function detectAndRegisterAutoMcpServers(dismissedIds: string[]): AutoDetectChange[] {
  const changes: AutoDetectChange[] = []
  const configPath = getMcpConfigPath()
  const servers = fs.existsSync(configPath) ? loadMcpServers() : {}

  for (const rule of AUTO_DETECT_RULES) {
    if (dismissedIds.includes(rule.id)) continue
    const detected = rule.match()
    if (!detected) continue

    const existing = servers[rule.id]
    if (!existing) {
      servers[rule.id] = detected
      changes.push({ id: rule.id, action: 'added' })
      continue
    }

    // Only refresh entries we still own (i.e., the existing command still points at this rule's
    // WindowsApps prefix). If the user customized it, leave it alone.
    if (
      'command' in existing &&
      'command' in detected &&
      rule.ownsCommand(existing.command) &&
      existing.command !== detected.command
    ) {
      servers[rule.id] = { ...existing, ...detected }
      changes.push({ id: rule.id, action: 'refreshed' })
    }
  }

  if (changes.length > 0) {
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8')
    for (const c of changes) {
      appLoggerInstance.info(`MCP auto-detect ${c.action}: ${c.id}`, 'mcp')
    }
  }
  return changes
}

export function isAutoDetectId(id: string): boolean {
  return AUTO_DETECT_RULES.some((r) => r.id === id)
}
