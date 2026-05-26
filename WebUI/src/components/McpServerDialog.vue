<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="sm:max-w-[425px]">
      <DialogHeader>
        <DialogTitle>{{ i18nState.MCP_DIALOG_TITLE }}</DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-4 py-4">
        <p v-if="errorMessage" class="text-sm text-destructive">
          {{ errorMessage }}
        </p>

        <div class="flex flex-col gap-2">
          <Label>{{ i18nState.MCP_TRANSPORT }}</Label>
          <RadioGroup v-model="transport" class="flex gap-4">
            <div class="flex items-center gap-2">
              <RadioGroupItem id="transport-stdio" value="stdio" />
              <Label for="transport-stdio" class="cursor-pointer">stdio</Label>
            </div>
            <div class="flex items-center gap-2">
              <RadioGroupItem id="transport-http" value="http" />
              <Label for="transport-http" class="cursor-pointer">http</Label>
            </div>
          </RadioGroup>
        </div>

        <div class="flex flex-col gap-2">
          <Label for="display-name">{{ i18nState.MCP_DISPLAY_NAME_LABEL }}</Label>
          <Input id="display-name" v-model="displayName" placeholder="My MCP Server" />
        </div>

        <div v-if="transport === 'stdio'" class="flex flex-col gap-2">
          <Label for="command">{{ i18nState.MCP_COMMAND_LABEL }}</Label>
          <Input id="command" v-model="command" placeholder="uvx" />
          <span class="text-xs text-muted-foreground">
            {{ i18nState.MCP_COMMAND_HINT }}
          </span>
        </div>

        <div v-if="transport === 'stdio'" class="flex flex-col gap-2">
          <Label for="args">{{ i18nState.MCP_ARGS_LABEL }}</Label>
          <Input id="args" v-model="args" placeholder="mcp-server-time" />
          <span class="text-xs text-muted-foreground">
            {{ i18nState.MCP_ARGS_HINT }}
          </span>
        </div>

        <div v-if="transport === 'http'" class="flex flex-col gap-2">
          <Label for="url">{{ i18nState.MCP_URL_LABEL }}</Label>
          <Input id="url" v-model="url" placeholder="https://example.com/mcp" />
        </div>
      </div>

      <div class="flex justify-between gap-2">
        <div class="flex gap-2">
          <Button
            v-if="!isAddMode"
            variant="destructive"
            :disabled="isSubmitting"
            @click="handleRemove"
          >
            {{ i18nState.MCP_REMOVE_BUTTON }}
          </Button>
        </div>
        <div class="flex gap-2">
          <Button variant="outline" @click="handleClose">{{ i18nState.COM_CANCEL }}</Button>
          <Button :disabled="isSubmitting" @click="handleSubmit">
            {{
              isSubmitting
                ? isAddMode
                  ? i18nState.MCP_ADDING
                  : i18nState.MCP_UPDATING
                : isAddMode
                  ? i18nState.MCP_ADD_SERVER_BUTTON
                  : i18nState.MCP_UPDATE_SERVER_BUTTON
            }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useMcp } from '@/assets/js/store/mcp'
import { useI18N } from '@/assets/js/store/i18n'
import * as toast from '@/assets/js/toast'
import type { McpServerConfig } from '../../electron/subprocesses/mcpServers'

const i18nState = useI18N().state

const props = defineProps<{
  open: boolean
  editServer?: { id: string; config: McpServerConfig }
}>()

const isAddMode = computed(() => props.editServer === undefined)

const emits = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'added'): void
}>()

const mcp = useMcp()

const transport = ref<'stdio' | 'http'>('stdio')
const displayName = ref('')
const command = ref('')
const args = ref('')
const url = ref('')
const errorMessage = ref('')
const isSubmitting = ref(false)

function populateFormFromConfig(config: McpServerConfig) {
  displayName.value = config.displayName ?? ''
  if (config.type !== 'http') {
    transport.value = 'stdio'
    command.value = config.command
    args.value = config.args?.join(' ') ?? ''
    url.value = ''
  } else {
    transport.value = 'http'
    url.value = config.url
    command.value = ''
    args.value = ''
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    const editServer = props.editServer
    if (editServer === undefined) {
      resetForm()
    } else {
      populateFormFromConfig(editServer.config)
    }
  },
)

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emits('update:open', value),
})

function resetForm() {
  transport.value = 'stdio'
  displayName.value = ''
  command.value = ''
  args.value = ''
  url.value = ''
  errorMessage.value = ''
}

function parseArgs(argsInput: string): string[] {
  return argsInput
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s)
}

function generateUniqueId(baseName: string): string {
  const baseId = baseName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

  let id = baseId
  let counter = 1

  while (mcp.allServers.some((s) => s.id === id)) {
    id = `${baseId}-${counter}`
    counter++
  }

  return id
}

function getServerId(): string {
  const editServer = props.editServer
  if (editServer === undefined) {
    return generateUniqueId(displayName.value.trim())
  }
  return editServer.id
}

function buildStdioConfig(name: string, cmd: string): McpServerConfig {
  return {
    command: cmd,
    args: parseArgs(args.value),
    displayName: name,
  }
}

function buildHttpConfig(name: string, httpUrl: string): McpServerConfig {
  return {
    type: 'http',
    url: httpUrl,
    displayName: name,
  }
}

async function handleSubmit() {
  errorMessage.value = ''

  const name = displayName.value.trim()
  const cmd = command.value.trim()
  const httpUrl = url.value.trim()

  if (!name) {
    errorMessage.value = i18nState.MCP_DISPLAY_NAME_REQUIRED
    return
  }

  if (transport.value === 'stdio' && !cmd) {
    errorMessage.value = i18nState.MCP_COMMAND_REQUIRED
    return
  }

  if (transport.value === 'http' && !httpUrl) {
    errorMessage.value = i18nState.MCP_URL_REQUIRED
    return
  }

  const id = getServerId()
  const config =
    transport.value === 'http' ? buildHttpConfig(name, httpUrl) : buildStdioConfig(name, cmd)

  isSubmitting.value = true

  try {
    if (isAddMode.value) {
      await handleAdd(id, config, name)
    } else {
      await handleUpdate(id, config, name)
    }
  } catch (error) {
    errorMessage.value =
      error instanceof Error
        ? error.message
        : isAddMode.value
          ? i18nState.MCP_ADD_FAILED
          : i18nState.MCP_UPDATE_FAILED
    toast.error(errorMessage.value)
  } finally {
    isSubmitting.value = false
  }
}

async function handleAdd(id: string, config: McpServerConfig, name: string) {
  await window.electronAPI.mcp.addServer(id, config)
  await mcp.reloadConfig()
  toast.success(`${i18nState.MCP_SERVER_ADDED_PREFIX} "${name}"`)
  resetForm()
  emits('update:open', false)
  emits('added')
}

async function handleUpdate(id: string, config: McpServerConfig, name: string) {
  await window.electronAPI.mcp.updateServer(id, config)
  await mcp.reloadConfig()
  toast.success(`${i18nState.MCP_SERVER_UPDATED_PREFIX} "${name}"`)
  resetForm()
  emits('update:open', false)
  emits('added')
}

async function handleRemove() {
  const editServer = props.editServer
  if (editServer === undefined) return
  isSubmitting.value = true
  try {
    await window.electronAPI.mcp.removeServer(editServer.id)
    await mcp.reloadConfig()
    toast.success(i18nState.MCP_SERVER_REMOVED)
    emits('update:open', false)
    resetForm()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : i18nState.MCP_REMOVE_FAILED)
  } finally {
    isSubmitting.value = false
  }
}

function handleClose() {
  resetForm()
  emits('update:open', false)
}
</script>
