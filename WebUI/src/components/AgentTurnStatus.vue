<template>
  <!-- A tool can put a question to the user mid-turn (Quick Coder offering to
       hand the game to Game Agent). Same card as Chat, keyed by the session. -->
  <ChatConfirmation :conversation-key="agentMode.openSessionId" with-avatar />

  <div v-if="agentMode.processing" class="flex items-center gap-2 text-sm text-muted-foreground">
    <span class="inline-block size-2 rounded-full bg-current animate-pulse"></span>
    <span>{{
      agentMode.turnState === 'queued' ? languages.AGENT_TURN_QUEUED_DETAIL : busyLabel
    }}</span>
  </div>
  <div v-if="heldAnswer" class="flex items-center gap-2 text-xs text-muted-foreground">
    <span role="status" class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
      <ChatBubbleLeftEllipsisIcon class="size-3.5" aria-hidden="true" />
      {{ withChannel(languages.AGENT_HELD_ANSWER_WAITING, heldAnswer.channel) }}
    </span>
    <TooltipProvider :delay-duration="200">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="secondary"
            size="sm"
            class="h-6 px-2 text-xs"
            :aria-label="withChannel(languages.AGENT_HELD_ANSWER_DISCARD_HINT, heldAnswer.channel)"
            @click="agentMode.discardHeldAnswer(agentMode.openSessionId)"
          >
            <XMarkIcon class="size-3.5" aria-hidden="true" />
            {{ languages.AGENT_HELD_ANSWER_DISCARD }}
          </Button>
        </TooltipTrigger>
        <TooltipContent class="max-w-xs">
          {{ withChannel(languages.AGENT_HELD_ANSWER_DISCARD_HINT, heldAnswer.channel) }}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
  <div
    v-if="agentMode.chat.error"
    class="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
  >
    {{ agentMode.chat.error.message }}
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChatBubbleLeftEllipsisIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useI18N } from '@/assets/js/store/i18n'
import { useMediaAgentRuns } from '@/assets/js/store/mediaAgentRuns'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import ChatConfirmation from '@/components/ChatConfirmation.vue'
import { getDescriptor } from '@/assets/js/store/channels/channelRegistry'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { busyLabelOf } from '@/lib/agentTranscript'
import { fillTemplate } from '@/lib/notificationLabel'

/** What the open agent session's turn is doing below its transcript: questions, progress, errors. */
const agentMode = useAgentMode()
const mediaRuns = useMediaAgentRuns()
const languages = useI18N().state

function withChannel(template: string, channel: ChannelKind): string {
  const name = getDescriptor(channel)?.displayName ?? channel
  return fillTemplate(template, { channel: name })
}

const heldAnswer = computed(() => agentMode.heldAnswers[agentMode.openSessionId])

const busyLabel = computed<string>(() =>
  busyLabelOf(agentMode.messages.at(-1)?.parts ?? [], (toolCallId) =>
    mediaRuns.activeStepLabel(toolCallId),
  ),
)
</script>
