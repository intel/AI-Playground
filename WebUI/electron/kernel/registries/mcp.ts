import { exec } from 'node:child_process'
import { shell } from 'electron'
import type { InvokeHandlerMap, McpInvokeName, McpSendName, SendHandlerMap } from '../ipcRegistries'
import type { LocalSettings } from '../../kernel/localSettings'
import type {
  getMcpServerStatus,
  invokeMcpServerTool,
  listMcpServers,
  listMcpServerTools,
  startMcpServer,
  stopAllMcpServers,
  stopMcpServer,
} from '../../adapters/mcp/mcpManager'
import type {
  addMcpServer,
  getMcpConfigPath,
  getMcpServerConfig,
  isAutoDetectId,
  removeMcpServer,
  updateMcpServer,
} from '../../adapters/mcp/mcpServers'

/**
 * The MCP manager/config seams the thirteen mcp handlers close over.
 * `settings` is the live settings object — removeServer writes an
 * auto-detect dismissal to it — and `persistLocalSettingsToDisk` is main's
 * settings writer.
 */
export type McpDeps = {
  settings: LocalSettings
  persistLocalSettingsToDisk: () => void
  startMcpServer: typeof startMcpServer
  stopMcpServer: typeof stopMcpServer
  stopAllMcpServers: typeof stopAllMcpServers
  getMcpServerStatus: typeof getMcpServerStatus
  listMcpServers: typeof listMcpServers
  listMcpServerTools: typeof listMcpServerTools
  invokeMcpServerTool: typeof invokeMcpServerTool
  getMcpConfigPath: typeof getMcpConfigPath
  addMcpServer: typeof addMcpServer
  getMcpServerConfig: typeof getMcpServerConfig
  updateMcpServer: typeof updateMcpServer
  removeMcpServer: typeof removeMcpServer
  isAutoDetectId: typeof isAutoDetectId
}

export function buildMcpRegistry(deps: McpDeps) {
  return {
    'mcp:startServer': async (_event, serverId) => {
      return await deps.startMcpServer(serverId)
    },

    'mcp:listServers': () => {
      return deps.listMcpServers()
    },

    'mcp:stopServer': async (_event, serverId) => {
      return await deps.stopMcpServer(serverId)
    },

    'mcp:getServerStatus': (_event, serverId) => {
      return deps.getMcpServerStatus(serverId)
    },

    'mcp:listServerTools': async (_event, serverId) => {
      return await deps.listMcpServerTools(serverId)
    },

    'mcp:invokeServerTool': async (_event, serverId, toolName, args) => {
      return await deps.invokeMcpServerTool(serverId, toolName, args)
    },

    'mcp:reloadConfig': async () => {
      await deps.stopAllMcpServers()
      return deps.listMcpServers()
    },

    'mcp:addServer': async (_event, serverId, config) => {
      return deps.addMcpServer(serverId, config)
    },

    'mcp:getServerConfig': (_event, serverId) => {
      return deps.getMcpServerConfig(serverId)
    },

    'mcp:updateServer': async (_event, serverId, config) => {
      await deps.stopMcpServer(serverId)
      return deps.updateMcpServer(serverId, config)
    },

    'mcp:removeServer': async (_event, serverId) => {
      await deps.stopMcpServer(serverId)
      const result = deps.removeMcpServer(serverId)
      if (
        deps.isAutoDetectId(serverId) &&
        !deps.settings.mcpAutoDetectionDismissed.includes(serverId)
      ) {
        deps.settings.mcpAutoDetectionDismissed = [
          ...deps.settings.mcpAutoDetectionDismissed,
          serverId,
        ]
        deps.persistLocalSettingsToDisk()
      }
      return result
    },
  } satisfies InvokeHandlerMap<McpInvokeName>
}

export function buildMcpSendRegistry(deps: McpDeps) {
  // TODO: Consider consolidating with openImageWithSystem/openImageInFolder
  // into generic openFileWithSystem/openFileInFolder that take file paths
  return {
    'mcp:openConfig': () => {
      const configPath = deps.getMcpConfigPath()
      shell.openPath(configPath)
    },

    'mcp:openConfigInFolder': () => {
      const configPath = deps.getMcpConfigPath()
      if (process.platform === 'win32') {
        exec(`explorer.exe /select, "${configPath}"`)
      } else {
        shell.showItemInFolder(configPath)
      }
    },
  } satisfies SendHandlerMap<McpSendName>
}
