<template>
  <MarkdownRenderer v-if="part.type === 'text'" :content="part.text ?? ''" />
  <ChatReasoningDisplay
    v-else-if="part.type === 'reasoning'"
    :text="part.text"
    :streaming="part.state === 'streaming' && !reasoningTiming.finishedAt"
    :startedAt="reasoningTiming.startedAt"
    :finishedAt="reasoningTiming.finishedAt"
  />
  <div
    v-else-if="compaction"
    class="flex flex-col gap-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
  >
    <div class="flex items-center gap-2 font-medium text-foreground/80">
      <ArchiveBoxArrowDownIcon class="size-4" />
      <span>
        Context compacted
        <span class="text-muted-foreground">({{ compaction.trigger }})</span>
        <template v-if="compactionDelta"> — {{ compactionDelta }}</template>
      </span>
    </div>
    <p v-if="compaction.summary" class="whitespace-pre-wrap opacity-80">{{ compaction.summary }}</p>
  </div>
  <!-- Media delegation tool: the nested media agent runs in the renderer, so its
       live steps (mediaAgentRuns, keyed by the bridged toolCallId) and the
       produced media render inline while the bridged call is still pending. -->
  <div v-else-if="mediaToolNameOf(part)" class="flex flex-col gap-2">
    <ChatToolDisplay :part="toolPart" :state="toolPart.state" :input="toolPart.input" />
    <MediaAgentTimeline :tool-call-id="toolPart.toolCallId" :fallback-steps="mediaToolSteps" />
    <ChatWorkflowResult
      :images="mediaToolImages"
      :processing="mediaToolProcessing"
      :stepText="mediaToolStepText"
    />
  </div>
  <div v-else-if="isToolUIPart(part)" class="flex flex-col gap-1">
    <ChatToolDisplay :part="toolPart" :state="toolPart.state" :input="toolPart.input" />
    <!-- Live output while the tool is still running (Pi streams partial results,
         e.g. a long-running bash command). -->
    <pre
      v-if="toolProgressText"
      class="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      >{{ toolProgressText }}</pre>
    <!-- What the tool saw: a browser screenshot never reaches the model as
         pixels, so this is the only place it is visible. -->
    <figure v-for="image in toolImages" :key="image.dataUri" class="flex flex-col gap-1">
      <img
        :src="image.dataUri"
        :alt="`Screenshot: ${image.label}`"
        class="max-h-96 w-auto self-start rounded-md border border-border"
      />
      <figcaption class="text-xs text-muted-foreground">{{ image.label }}</figcaption>
    </figure>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { isToolUIPart, type UIDataTypes, type UIMessagePart, type UITools } from 'ai'
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useMediaAgentRuns } from '@/assets/js/store/mediaAgentRuns'
import type { AipgTools } from '@/assets/js/tools/tools'
import type { MediaItem } from '@/assets/js/store/imageGenerationPresets'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import ChatToolDisplay from '@/components/ChatToolDisplay.vue'
import ChatReasoningDisplay from '@/components/ChatReasoningDisplay.vue'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import MediaAgentTimeline from '@/components/MediaAgentTimeline.vue'
import { compactionOutputOf, mediaToolNameOf } from '@/lib/agentTranscript'
import { reasoningTimingOf } from '@/lib/reasoningTimings'
import { ArchiveBoxArrowDownIcon } from '@heroicons/vue/24/outline'

// One part of an assistant message in Agent Mode: text, a reasoning block, a
// compaction notice, or a tool call — with whatever the call produced under it
// (streamed output, browser screenshots, generated media).

const props = defineProps<{ part: UIMessagePart<UIDataTypes, UITools> }>()

const agentMode = useAgentMode()
const mediaRuns = useMediaAgentRuns()

// Pi's tool parts (tool-bash, tool-read, …) are not part of AipgTools, but the
// generic ChatToolDisplay only reads name/state/input/output — cast for reuse.
const toolPart = computed(() => props.part as unknown as ToolUIPart<AipgTools> | DynamicToolUIPart)

/** Tail of a running tool's streamed output kept on screen. */
const MAX_PROGRESS_LINES = 12

/** Arguments long enough to be worth watching arrive (file bodies, patches). */
const STREAMED_ARGUMENT_KEYS = ['content', 'new_string', 'command']

// Two kinds of live text can sit under a tool card, both keyed to a call that
// has not finished: the output Pi streams back over its own IPC channel (merged
// into the store by tool call id), and — before the tool even runs — the
// arguments the model is still dictating, which for a file write is the file.
const toolProgressText = computed<string | undefined>(() => {
  const tool = toolPart.value
  if (tool.state !== 'input-available' && tool.state !== 'input-streaming') return undefined
  const text = agentMode.toolProgress[tool.toolCallId] ?? streamedArgument(tool.input)
  if (!text) return undefined
  return text.split('\n').slice(-MAX_PROGRESS_LINES).join('\n')
})

function streamedArgument(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  const key = STREAMED_ARGUMENT_KEYS.find((candidate) => typeof record[candidate] === 'string')
  return key ? (record[key] as string) : undefined
}

const toolImages = computed<AgentToolImage[]>(
  () => agentMode.toolImages[toolPart.value.toolCallId] ?? [],
)

const compaction = computed(() => compactionOutputOf(props.part))
const reasoningTiming = computed(() => reasoningTimingOf(props.part))

// Pi's post-compaction size is an estimate it cannot always produce, so fall
// back to reporting just how much was summarized.
const compactionDelta = computed<string>(() => {
  const output = compaction.value
  if (!output || output.tokensBefore === undefined) return ''
  const before = output.tokensBefore.toLocaleString()
  if (output.tokensAfter === undefined) return `${before} tokens summarized`
  return `${before} → ${output.tokensAfter.toLocaleString()} tokens`
})

type MediaToolOutput = { images?: unknown; steps?: unknown }

const mediaOutput = computed<MediaToolOutput | undefined>(
  () => (props.part as { output?: MediaToolOutput }).output,
)

/** Step lines from a finished result, for runs no longer in the store. */
const mediaToolSteps = computed<string[] | undefined>(() => {
  const steps = mediaOutput.value?.steps
  return Array.isArray(steps) ? (steps as string[]) : undefined
})

const mediaRun = computed(() => mediaRuns.run(toolPart.value.toolCallId))

/** Finished media from the tool output, or what the live run has so far. */
const mediaToolImages = computed<MediaItem[]>(() => {
  if (mediaToolItems.value.length) return mediaToolItems.value
  return mediaRun.value?.steps.flatMap((step) => step.media) ?? []
})

const mediaToolProcessing = computed(() => mediaRun.value?.state === 'running')

const mediaToolStepText = computed(() => mediaRuns.activeStepLabel(toolPart.value.toolCallId))

/**
 * Completed tool parts whose output carries a comfy-shaped `images` array,
 * synthesized into full MediaItems so ChatWorkflowResult renders images,
 * videos and 3D models alike.
 */
const mediaToolItems = computed<MediaItem[]>(() => {
  if (!mediaToolNameOf(props.part) || toolPart.value.state !== 'output-available') return []
  const images = mediaOutput.value?.images
  if (!Array.isArray(images)) return []
  return images
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(
      (item) =>
        ({
          mode: 'imageGen',
          settings: {},
          ...item,
          state: 'done',
        }) as MediaItem,
    )
    .filter((item) => {
      if (item.type === 'image') return !!item.imageUrl
      if (item.type === 'video') return !!item.videoUrl
      if (item.type === 'model3d') return !!item.model3dUrl
      return false
    })
})
</script>
