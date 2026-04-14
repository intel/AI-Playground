<template>
  <div class="rounded-md border border-border/80 bg-muted/20 flex flex-col">
    <div
      class="px-3 py-3 flex items-center justify-between gap-2 cursor-pointer"
      @click="isExpanded = !isExpanded"
    >
      <span class="text-sm text-muted-foreground">MCP tool call - {{ toolDisplayName }}</span>
      <span class="text-xs rounded-md border border-border px-2 py-1" :class="stateClass">
        {{ stateLabel }}
      </span>
    </div>

    <div
      v-if="isExpanded"
      class="px-3 pb-3 animate-in fade-in-0 zoom-in-95 duration-200 flex flex-col gap-2"
    >
      <details class="mt-2" v-if="part.input" open>
        <summary class="cursor-pointer text-xs text-muted-foreground">Arguments</summary>
        <pre class="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs leading-5">{{
          formattedInput
        }}</pre>
      </details>

      <details class="mt-2" v-if="part.state === 'output-available'" open>
        <summary class="cursor-pointer text-xs text-muted-foreground">Result</summary>
        <pre class="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs leading-5">{{
          formattedOutput
        }}</pre>
      </details>

      <div
        v-if="errorText"
        class="mt-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
      >
        {{ errorText }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { getToolOrDynamicToolName, type DynamicToolUIPart } from 'ai'

const props = defineProps<{
  part: DynamicToolUIPart
  state: DynamicToolUIPart['state']
}>()

const isExpanded = ref(false)

const toolDisplayName = computed(() => {
  const rawName = getToolOrDynamicToolName(props.part)
  if (rawName.startsWith('mcp__')) {
    const parts = rawName.split('__')
    const serverId = parts.length >= 3 ? parts[1] : 'unknown'
    const toolName = parts.length >= 3 ? parts.slice(2).join('__') : rawName
    return `${serverId} MCP - ${toolName}`
  }
  return rawName
})

const stateLabel = computed(() => {
  if (props.state === 'input-streaming') return 'Running'
  if (props.state === 'input-available') return 'Queued'
  if (props.state === 'output-available') return 'Completed'
  if (props.state === 'output-error') return 'Failed'
  return props.state
})

const stateClass = computed(() => {
  if (props.state === 'output-available') return 'text-green-600'
  if (props.state === 'output-error') return 'text-destructive'
  if (props.state === 'input-streaming' || props.state === 'input-available')
    return 'text-amber-500'
  return 'text-muted-foreground'
})

const errorText = computed(() => {
  if (props.state === 'output-error') {
    return props.part.errorText
  }
  return null
})

const formattedInput = computed(() => formatToolPayload(props.part.input))
const formattedOutput = computed(() => formatToolPayload(props.part.output))

function formatToolPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}
</script>
