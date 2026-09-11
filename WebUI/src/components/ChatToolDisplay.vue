<template>
  <div class="rounded-md border border-border/80 bg-muted/20 flex flex-col">
    <div
      class="px-3 py-3 flex items-center justify-between gap-2 cursor-pointer"
      @click="isExpanded = !isExpanded"
    >
      <span class="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span class="shrink-0">Tool call - {{ toolDisplayName }}</span>
        <!-- Subject of the call (file, command, …) so a card that stays open for
             minutes says what it is working on without being expanded. -->
        <span v-if="inputSubject()" class="truncate text-xs opacity-70">{{ inputSubject() }}</span>
      </span>
      <span class="flex shrink-0 items-center gap-2">
        <span v-if="streamedSize()" class="text-xs text-muted-foreground/80">
          {{ streamedSize() }}
        </span>
        <span class="text-xs rounded-md border border-border px-2 py-1" :class="stateClass">
          {{ stateLabel }}
        </span>
      </span>
    </div>

    <div
      v-if="isExpanded"
      class="px-3 pb-3 animate-in fade-in-0 zoom-in-95 duration-200 flex flex-col gap-2"
    >
      <details class="mt-2" v-if="currentInput()" open>
        <summary class="cursor-pointer text-xs text-muted-foreground">Arguments</summary>
        <pre class="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs leading-5">{{
          formattedInput()
        }}</pre>
      </details>

      <details class="mt-2" v-if="part.state === 'output-available'" open>
        <summary class="cursor-pointer text-xs text-muted-foreground">Result</summary>
        <pre class="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs leading-5">{{
          formattedOutput()
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
import { getToolOrDynamicToolName, type DynamicToolUIPart, type ToolUIPart } from 'ai'
import type { AipgTools } from '@/assets/js/tools/tools'
import { toolDisplayLabel } from '@/assets/js/tools/toolLabels'

// `state` and `input` duplicate fields of `part` on purpose: the AI SDK grows a
// tool part by mutating it, so the part object alone never looks different to
// Vue and this card would not re-render while arguments stream in. Read off the
// part in the parent's template, they arrive as changing props.
const props = defineProps<{
  part: ToolUIPart<AipgTools> | DynamicToolUIPart
  state: (ToolUIPart<AipgTools> | DynamicToolUIPart)['state']
  input?: unknown
}>()

const isExpanded = ref(false)

const toolDisplayName = computed(() => toolDisplayLabel(getToolOrDynamicToolName(props.part)))

// `input-streaming` is the model still dictating the arguments (which for a big
// `write` is the bulk of the wait), `input-available` is the call executing.
const stateLabel = computed(() => {
  if (props.state === 'input-streaming') return 'Preparing'
  if (props.state === 'input-available') return 'Running'
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
    return (props.part as { errorText?: string }).errorText
  }
  return null
})

// Argument keys that identify what a call acts on, most specific first. Covers
// the agent's file/shell tools and the app's own media/browser tools.
const SUBJECT_KEYS = [
  'path',
  'file_path',
  'filePath',
  'command',
  'pattern',
  'url',
  'query',
  'request',
  'prompt',
]

const MAX_SUBJECT_LENGTH = 72

// Plain functions, not computeds, for the same reason (an in-place mutation
// notifies nothing, so a cached computed would keep the value it had on first
// render — for a streaming call, before its arguments existed).
function currentInput(): unknown {
  return props.input ?? props.part.input
}

function inputSubject(): string {
  const input = currentInput()
  if (typeof input !== 'object' || input === null) return ''
  const record = input as Record<string, unknown>
  const key = SUBJECT_KEYS.find(
    (candidate) => typeof record[candidate] === 'string' && record[candidate],
  )
  if (!key) return ''
  const text = String(record[key]).replace(/\s+/g, ' ').trim()
  return text.length > MAX_SUBJECT_LENGTH ? `${text.slice(0, MAX_SUBJECT_LENGTH)}…` : text
}

// While arguments stream in, their size is the only sign of progress there is —
// a file being written arrives character by character over minutes.
function streamedSize(): string {
  if (props.state !== 'input-streaming') return ''
  const input = currentInput()
  if (typeof input !== 'object' || input === null) return ''
  const characters = Object.values(input as Record<string, unknown>).reduce<number>(
    (total, value) => total + (typeof value === 'string' ? value.length : 0),
    0,
  )
  if (characters < 200) return ''
  return characters < 10_000
    ? `${characters.toLocaleString()} chars`
    : `${(characters / 1024).toFixed(1)}K chars`
}

function formattedInput(): string {
  return formatToolPayload(currentInput())
}

function formattedOutput(): string {
  return formatToolPayload((props.part as { output?: unknown }).output)
}

function formatToolPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}
</script>
