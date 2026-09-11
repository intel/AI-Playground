<script setup lang="ts">
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'

const props = defineProps<{
  text?: string
  startedAt?: number
  finishedAt?: number
  streaming?: boolean
  // Wall-clock start of the live reasoning block, supplied by the store while
  // `streaming` is true. The part's own `startedAt`/`finishedAt` metadata is
  // only attached once the block finishes, so the increasing timer relies on
  // this instead.
  liveStartedAt?: number
  onCopy?: (text: string) => void
}>()

const isExpanded = ref(false)

// Reactive "now" so the elapsed timer actually advances while streaming —
// `Date.now()` on its own is not reactive and would freeze the displayed value.
const now = ref(Date.now())
let tickHandle: ReturnType<typeof setInterval> | undefined
watch(
  () => props.streaming,
  (streaming) => {
    clearInterval(tickHandle)
    tickHandle = undefined
    if (streaming) {
      now.value = Date.now()
      tickHandle = setInterval(() => (now.value = Date.now()), 100)
    }
  },
  { immediate: true },
)
onUnmounted(() => clearInterval(tickHandle))

// Undefined when the host recorded no timing for this block — a duration is
// only invented if it was actually measured.
const elapsedSeconds = computed<string | undefined>(() => {
  if (props.streaming) {
    const start = props.liveStartedAt || props.startedAt
    return start ? ((now.value - start) / 1000).toFixed(1) : undefined
  }
  if (!props.startedAt) return undefined
  return (((props.finishedAt ?? props.startedAt) - props.startedAt) / 1000).toFixed(1)
})

const statusText = computed(() => {
  const seconds = elapsedSeconds.value
  if (props.streaming) return seconds ? `Reasoning for ${seconds} seconds` : 'Reasoning…'
  if (seconds && props.finishedAt) return `Done Reasoning after ${seconds} seconds`
  // A restored transcript keeps the trace but not its timing.
  return 'Reasoning trace'
})
</script>

<template>
  <div>
    <button @click="isExpanded = !isExpanded" class="flex items-center cursor-pointer">
      <span class="italic text-muted-foreground">{{ statusText }}</span>
      <img v-if="isExpanded" src="../assets/svg/arrow-up.svg" class="w-4 h-4 ml-1" />
      <img v-else src="../assets/svg/arrow-down.svg" class="w-4 h-4 ml-1" />
    </button>
    <MarkdownRenderer
      v-if="isExpanded"
      class="border-l-2 border-border pl-4 text-muted-foreground"
      :content="text ?? ''"
      :on-copy="onCopy"
    />
  </div>
</template>
