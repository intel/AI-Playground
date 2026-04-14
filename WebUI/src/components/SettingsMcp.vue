<template>
  <div class="flex flex-col gap-2 border border-border rounded-md p-3 mr-4">
    <div
      v-for="server in mcp.allServers"
      :key="server.id"
      class="flex items-center justify-between gap-3"
    >
      <div class="flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full" :class="getStatusDotClass(server.id)" />
        <Label class="whitespace-nowrap">{{ server.name }}</Label>
        <span class="text-xs text-muted-foreground">{{ getStatusText(server.id) }}</span>
      </div>

      <div class="flex items-center gap-1">
        <Button
          variant="secondary"
          size="sm"
          class="px-3 py-1.5 rounded text-sm"
          :disabled="!textInference.mcpToolsEnabled || mcp.isServerBusy(server.id)"
          @click="mcp.toggleServer(server.id)"
        >
          {{ getStartButtonText(server.id) }}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" class="h-7 w-7">
              <EllipsisHorizontalIcon class="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem @select="openEditDialog(server.id)"> Edit </DropdownMenuItem>
            <DropdownMenuItem
              class="text-destructive focus:text-destructive"
              @select="handleRemoveServer(server.id)"
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <div v-if="mcp.allServers.length === 0" class="text-sm text-muted-foreground text-center py-2">
      No MCP servers available
    </div>

    <!-- Red error messages -->

    <template v-for="server in mcp.allServers" :key="'error-' + server.id">
      <p v-if="mcp.getServerStatus(server.id).lastError" class="text-xs text-destructive">
        {{ server.name }}: {{ mcp.getServerStatus(server.id).lastError }}
      </p>
    </template>

    <p v-if="mcp.configError" class="text-xs text-destructive">
      {{ mcp.configError }}
    </p>

    <!-- Footer: config actions -->

    <div class="flex justify-start gap-4 pl-2">
      <Button
        variant="link"
        size="sm"
        class="px-0 text-muted-foreground gap-1"
        @click="showAddDialog = true"
      >
        <span class="svg-icon i-add w-4 h-4 shrink-0" />
        Add server...
      </Button>
      <Button variant="link" size="sm" class="px-0 text-muted-foreground gap-1" @click="openConfig">
        <span class="svg-icon i-pen w-4 h-4 shrink-0" />
        Edit mcp.json
      </Button>
      <Button
        variant="link"
        size="sm"
        class="px-0 text-muted-foreground gap-1"
        @click="openConfigInFolder"
      >
        <span class="svg-icon i-folder w-4 h-4 shrink-0" />
        Show in folder
      </Button>
      <Button
        variant="link"
        size="sm"
        class="px-0 text-muted-foreground gap-1"
        @click="reloadConfig"
      >
        <span class="svg-icon i-refresh w-4 h-4 shrink-0" />
        Reload
      </Button>
    </div>

    <McpServerDialog v-model:open="showAddDialog" />
    <McpServerDialog v-model:open="showEditDialog" :edit-server="editServer" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMcp } from '@/assets/js/store/mcp'
import { useTextInference } from '@/assets/js/store/textInference'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { EllipsisHorizontalIcon } from '@heroicons/vue/24/outline'
import * as toast from '@/assets/js/toast'
import McpServerDialog from '@/components/McpServerDialog.vue'
import type { McpServerConfig } from '../../electron/subprocesses/mcpServers'

const mcp = useMcp()
const textInference = useTextInference()
const showAddDialog = ref(false)
const showEditDialog = ref(false)
const editServer = ref<{ id: string; config: McpServerConfig } | undefined>()

function getStatusText(serverId: string): string {
  const status = mcp.getServerStatus(serverId)
  if (status.state === 'stopped') return 'Disconnected'
  if (status.state === 'starting') return 'Starting...'
  if (status.state === 'running') return 'Connected'
  if (status.state === 'error') return 'Error'
  return 'Disconnected'
}

function getStatusDotClass(serverId: string): string {
  const status = mcp.getServerStatus(serverId)
  if (status.state === 'stopped') return 'bg-muted-foreground/40'
  if (status.state === 'starting') return 'bg-amber-500 animate-pulse'
  if (status.state === 'running') return 'bg-green-500'
  if (status.state === 'error') return 'bg-destructive'
  return 'bg-muted-foreground/40'
}

function getStartButtonText(serverId: string): string {
  const status = mcp.getServerStatus(serverId)
  if (status.state === 'stopped') return 'Start'
  if (status.state === 'starting') return 'Stop'
  if (status.state === 'running') return 'Stop'
  if (status.state === 'error') return 'Start'
  return 'Start'
}

onMounted(async () => {
  await mcp.refreshAllServerStatuses()
})

async function openConfig() {
  window.electronAPI.mcp.openConfig()
}

async function openConfigInFolder() {
  window.electronAPI.mcp.openConfigInFolder()
}

async function reloadConfig() {
  await mcp.reloadConfig()
}

async function openEditDialog(serverId: string) {
  try {
    const config = await window.electronAPI.mcp.getServerConfig(serverId)
    editServer.value = { id: serverId, config }
    showEditDialog.value = true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to get server config')
  }
}

async function handleRemoveServer(serverId: string) {
  try {
    await window.electronAPI.mcp.removeServer(serverId)
    await mcp.reloadConfig()
    toast.success('MCP server removed')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to remove server')
  }
}
</script>
