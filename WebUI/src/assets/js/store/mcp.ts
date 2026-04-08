import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as toast from '@/assets/js/toast'

type McpConnectionState = 'stopped' | 'starting' | 'running' | 'error'

type McpStatus = {
  state: McpConnectionState
  lastError?: string
}

type McpToolInfo = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

type McpServerInfo = {
  id: string
  name: string
}

type ServerState = {
  status: McpStatus
  tools: McpToolInfo[]
}

export const useMcp = defineStore('mcp', () => {
  const servers = ref<Map<string, ServerState>>(new Map())
  const availableServers = ref<McpServerInfo[]>([])
  const configError = ref<string | null>(null)

  const allServers = computed(() => availableServers.value)

  function formatConfigError(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : fallback
    return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  }

  function getServerState(serverId: string): ServerState {
    return (
      servers.value.get(serverId) ?? {
        status: { state: 'stopped' },
        tools: [],
      }
    )
  }

  function getServerStatus(serverId: string): McpStatus {
    return getServerState(serverId).status
  }

  function getServerTools(serverId: string): McpToolInfo[] {
    return getServerState(serverId).tools
  }

  function isServerConnected(serverId: string): boolean {
    return getServerState(serverId).status.state === 'running'
  }

  function isServerBusy(serverId: string): boolean {
    return getServerState(serverId).status.state === 'starting'
  }

  async function refreshAvailableServers() {
    try {
      availableServers.value = await window.electronAPI.mcp.listServers()
      configError.value = null
    } catch (error) {
      configError.value = formatConfigError(error, 'Failed to load MCP servers')
    }
  }

  async function refreshServerStatus(serverId: string) {
    try {
      const status = await window.electronAPI.mcp.getServerStatus(serverId)
      let tools: McpToolInfo[] = []

      if (status.state === 'running') {
        try {
          tools = await window.electronAPI.mcp.listServerTools(serverId)
        } catch (error) {
          console.error(`Failed to list MCP tools for ${serverId}:`, error)
          servers.value.set(serverId, {
            status: { state: 'error', lastError: String(error) },
            tools: [],
          })
          return
        }
      }

      servers.value.set(serverId, { status, tools })
    } catch (error) {
      console.error(`Failed to refresh MCP status for ${serverId}:`, error)
      servers.value.set(serverId, {
        status: { state: 'error', lastError: String(error) },
        tools: [],
      })
    }
  }

  async function refreshAllServerStatuses() {
    await refreshAvailableServers()
    await Promise.allSettled(availableServers.value.map((s) => refreshServerStatus(s.id)))
  }

  async function startServer(serverId: string) {
    servers.value.set(serverId, {
      status: { state: 'starting' },
      tools: [],
    })

    let status = await window.electronAPI.mcp.startServer(serverId)
    let tools: McpToolInfo[] = []

    if (status.state === 'running') {
      tools = await window.electronAPI.mcp.listServerTools(serverId)
      status = await window.electronAPI.mcp.getServerStatus(serverId)
      const serverInfo = availableServers.value.find((s) => s.id === serverId)
      if (status.state === 'running') {
        toast.success(`${serverInfo?.name ?? serverId} connected`)
      } else {
        toast.error(status.lastError || `Failed to start ${serverId}`)
      }
    } else {
      toast.error(status.lastError || `Failed to start ${serverId}`)
    }

    servers.value.set(serverId, { status, tools })
    return status
  }

  async function stopServer(serverId: string) {
    const status = await window.electronAPI.mcp.stopServer(serverId)
    servers.value.set(serverId, {
      status,
      tools: [],
    })
    const serverInfo = availableServers.value.find((s) => s.id === serverId)
    toast.success(`${serverInfo?.name ?? serverId} disconnected`)
    return status
  }

  async function toggleServer(serverId: string) {
    if (isServerConnected(serverId)) {
      return await stopServer(serverId)
    }
    return await startServer(serverId)
  }

  async function reloadConfig() {
    try {
      const serverList = await window.electronAPI.mcp.reloadConfig()
      availableServers.value = serverList
      servers.value.clear()
      configError.value = null
    } catch (error) {
      configError.value = formatConfigError(error, 'Failed to reload MCP config')
    }
  }

  return {
    servers,
    availableServers,
    allServers,
    configError,
    getServerState,
    getServerStatus,
    getServerTools,
    isServerConnected,
    isServerBusy,
    refreshAvailableServers,
    refreshServerStatus,
    refreshAllServerStatuses,
    startServer,
    stopServer,
    toggleServer,
    reloadConfig,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMcp, import.meta.hot))
}
