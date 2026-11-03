<template>
  <template v-for="segment in segmentsOf(message)" :key="segment.key">
    <AgentMessagePart v-if="segment.kind === 'part'" :part="asPart(segment.part)" />
    <!-- A finished stretch of thinking and tool calls, folded away so
         the answer and the media it produced stay in view. -->
    <AgentActivitySummary v-else :summary="segment.summary">
      <AgentMessagePart v-for="(part, index) in segment.parts" :key="index" :part="asPart(part)" />
    </AgentActivitySummary>
  </template>
</template>

<script setup lang="ts">
import type { UIDataTypes, UIMessagePart, UITools, UIMessage } from 'ai'
import { useAgentMode } from '@/assets/js/store/agentMode'
import AgentMessagePart from '@/components/AgentMessagePart.vue'
import AgentActivitySummary from '@/components/AgentActivitySummary.vue'
import {
  compactionOutputOf,
  groupTranscriptParts,
  isReasoningPart,
  showsGeneratedMedia,
  toolPartNameOf,
} from '@/lib/agentTranscript'

/** An agent reply: its tool cards, reasoning and step progress, folded once the turn is over. */
const props = defineProps<{
  message: UIMessage
  /** The message is being produced right now, so it is shown unfolded. */
  live?: boolean
}>()

const agentMode = useAgentMode()

// The AI SDK grows a part by mutating it, so the same object reference would
// leave AgentMessagePart showing whatever the part held when it mounted. A copy
// per render makes every mutated field arrive as a changed prop.
function asPart(part: unknown): UIMessagePart<UIDataTypes, UITools> {
  return { ...(part as object) } as UIMessagePart<UIDataTypes, UITools>
}

// `step-start` renders nothing, so it must not split a run of foldable parts.
function segmentsOf(message: UIMessage) {
  return groupTranscriptParts(
    (message.parts ?? []).filter((part) => part.type !== 'step-start'),
    { messageId: message.id, live: !!props.live, foldable: isFoldable },
  )
}

function isFoldable(part: unknown): boolean {
  if (isReasoningPart(part)) return true
  if (toolPartNameOf(part) === undefined) return false
  // Compaction is its own notice, media tools render what they generated, and a
  // browser screenshot is only ever visible here — none of it is noise.
  if (compactionOutputOf(part)) return false
  if (showsGeneratedMedia(part)) return false
  const toolCallId = (part as { toolCallId?: string }).toolCallId
  return !(toolCallId && agentMode.toolImages[toolCallId]?.length)
}
</script>
