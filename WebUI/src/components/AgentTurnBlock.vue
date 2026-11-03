<template>
  <!-- eslint-disable vue/require-v-for-key -->
  <template v-for="message in messages">
    <!-- eslint-enable -->
    <div v-if="message.role === 'user'" class="flex items-start gap-3">
      <UserCircleIcon class="size-6 text-foreground/90" />
      <div class="flex flex-col gap-2 max-w-4/5 bg-muted rounded-md px-4 py-3">
        <MarkdownRenderer :content="messageText(message)" />
        <span
          v-if="originOf(message)"
          role="note"
          :aria-label="withChannel(languages.AGENT_ANSWER_VIA_LABEL, originOf(message)!)"
          class="self-end inline-flex items-center gap-1 text-xs text-muted-foreground"
        >
          <DevicePhoneMobileIcon class="size-3.5" aria-hidden="true" />
          {{ withChannel(languages.AGENT_ANSWER_VIA, originOf(message)!) }}
        </span>
      </div>
      <span
        v-if="message.id === queuedMessageId"
        role="status"
        class="self-center inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
      >
        <ClockIcon class="size-3.5" aria-hidden="true" />
        {{ languages.AGENT_TURN_QUEUED }}
      </span>
      <div
        v-else-if="message.id === notRunMessageId"
        class="self-center flex items-center gap-2 text-xs text-muted-foreground"
      >
        <span
          role="status"
          class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5"
        >
          <ExclamationCircleIcon class="size-3.5" aria-hidden="true" />
          {{ languages.AGENT_TURN_NOT_RUN }}
        </span>
        <Button
          v-if="canResend && message.id === messages.at(-1)?.id"
          variant="secondary"
          size="sm"
          class="h-6 px-2 text-xs"
          @click="emit('resend')"
        >
          <ArrowPathIcon class="size-3.5" aria-hidden="true" />
          {{ languages.AGENT_TURN_RESEND }}
        </Button>
      </div>
    </div>
    <div v-else-if="message.role === 'assistant'" class="flex items-start gap-3">
      <img src="../assets/svg/ai-icon.svg" class="size-6" />
      <div class="flex flex-col gap-3 w-full max-w-4/5">
        <template v-for="segment in segmentsOf(message)" :key="segment.key">
          <AgentMessagePart v-if="segment.kind === 'part'" :part="asPart(segment.part)" />
          <!-- A finished stretch of thinking and tool calls, folded away so
               the answer and the media it produced stay in view. -->
          <AgentActivitySummary v-else :summary="segment.summary">
            <AgentMessagePart
              v-for="(part, index) in segment.parts"
              :key="index"
              :part="asPart(part)"
            />
          </AgentActivitySummary>
        </template>
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import type { UIDataTypes, UIMessagePart, UITools, UIMessage } from 'ai'
import { useAgentMode, type AgentMessageMetadata } from '@/assets/js/store/agentMode'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import AgentMessagePart from '@/components/AgentMessagePart.vue'
import AgentActivitySummary from '@/components/AgentActivitySummary.vue'
import {
  compactionOutputOf,
  groupTranscriptParts,
  isReasoningPart,
  showsGeneratedMedia,
  toolPartNameOf,
  type TranscriptSegment,
} from '@/lib/agentTranscript'
import { getDescriptor } from '@/assets/js/store/channels/channelRegistry'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { fillTemplate } from '@/lib/notificationLabel'
import {
  ArrowPathIcon,
  ClockIcon,
  DevicePhoneMobileIcon,
  ExclamationCircleIcon,
  UserCircleIcon,
} from '@heroicons/vue/24/outline'

/**
 * The messages of agent turns — the user's prompts and the agent's replies with
 * their tool cards, reasoning and step progress. Agent Mode renders its open
 * Harness Session with it, and the Session timeline its agent turns.
 */
const props = defineProps<{
  messages: UIMessage[]
  /** The last message is being produced right now, so it is shown unfolded. */
  live?: boolean
  queuedMessageId?: string
  notRunMessageId?: string
  canResend?: boolean
}>()

const emit = defineEmits<{ resend: [] }>()

const agentMode = useAgentMode()
const languages = useI18N().state

function originOf(message: UIMessage): ChannelKind | undefined {
  return (message.metadata as AgentMessageMetadata | undefined)?.origin
}

function withChannel(template: string, channel: ChannelKind): string {
  const name = getDescriptor(channel)?.displayName ?? channel
  return fillTemplate(template, { channel: name })
}

function messageText(message: UIMessage): string {
  return (
    message.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n') ?? ''
  )
}

// The AI SDK grows a part by mutating it, so the same object reference would
// leave AgentMessagePart showing whatever the part held when it mounted. A copy
// per render makes every mutated field arrive as a changed prop.
function asPart(part: unknown): UIMessagePart<UIDataTypes, UITools> {
  return { ...(part as object) } as UIMessagePart<UIDataTypes, UITools>
}

// Reasoning blocks and tool cards are what the agent did, not what it produced,
// and a single request makes dozens of them. Once the turn is over they collapse
// into one summary line; a part carrying something to look at stays out of the
// fold.
function segmentsOf(message: UIMessage): TranscriptSegment[] {
  // `step-start` renders nothing, so it must not split a run of foldable parts.
  const parts = (message.parts ?? []).filter((part) => part.type !== 'step-start')
  return groupTranscriptParts(parts, {
    messageId: message.id,
    live: !!props.live && message.id === props.messages.at(-1)?.id,
    foldable: isFoldable,
  })
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
