<template>
  <SessionUserBubble v-if="message.role === 'user'">
    <img v-if="attachedImage" :src="attachedImage" alt="Generated Image" />
    <audio
      v-for="(clip, clipIndex) in audioAttachments"
      :key="clipIndex"
      controls
      class="w-full max-w-md"
      :src="clip.url"
      :aria-label="clip.filename ?? 'Attached audio'"
    />
    <MarkdownRenderer :content="text" :on-copy="copyText" />
    <div class="flex items-center gap-3 text-xs text-muted-foreground">
      <button class="flex items-center gap-1" :title="languages.COM_COPY" @click="copyText(text)">
        <span class="svg-icon i-copy w-4 h-4"></span>
        <span>{{ languages.COM_COPY }}</span>
      </button>
      <span
        v-if="origin"
        role="note"
        :aria-label="withChannel(languages.AGENT_ANSWER_VIA_LABEL, origin)"
        class="ml-auto inline-flex items-center gap-1"
      >
        <DevicePhoneMobileIcon class="size-3.5" aria-hidden="true" />
        {{ withChannel(languages.AGENT_ANSWER_VIA, origin) }}
      </span>
    </div>
    <template #aside>
      <span
        v-if="queued"
        role="status"
        class="self-center inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
      >
        <ClockIcon class="size-3.5" aria-hidden="true" />
        {{ languages.AGENT_TURN_QUEUED }}
      </span>
      <div
        v-else-if="notRun"
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
          v-if="canResend"
          variant="secondary"
          size="sm"
          class="h-6 px-2 text-xs"
          @click="emit('resend')"
        >
          <ArrowPathIcon class="size-3.5" aria-hidden="true" />
          {{ languages.AGENT_TURN_RESEND }}
        </Button>
      </div>
    </template>
  </SessionUserBubble>
  <SessionAssistantBubble v-else-if="message.role === 'assistant'" :label="modelLabel">
    <template v-if="engine === 'chat' && ragSource" #badges>
      <button
        class="bg-primary text-foreground font-sans rounded-md px-1 py-1 flex items-center gap-1"
        :class="textInference.nameSizeClass"
        :aria-expanded="showRagSource"
        @click="showRagSource = !showRagSource"
      >
        Source Docs
        <img v-if="showRagSource" src="../assets/svg/arrow-up.svg" class="w-3 h-3" alt="" />
        <img v-else src="../assets/svg/arrow-down.svg" class="w-3 h-3" alt="" />
      </button>
    </template>
    <template v-if="engine === 'chat'">
      <ChatMessageParts
        :message="chatMessage"
        :last="last"
        :conversation-key="conversationKey ?? ''"
        :show-rag-source="showRagSource"
      />
      <ChatMessageActions :message="chatMessage" :last="last" />
    </template>
    <AgentMessageParts v-else :message="message" :live="live" />
  </SessionAssistantBubble>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { UIMessage } from 'ai'
import type { AgentMessageMetadata } from '@/assets/js/store/agentMode'
import { useI18N } from '@/assets/js/store/i18n'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import { useTextInference } from '@/assets/js/store/textInference'
import { getDescriptor } from '@/assets/js/store/channels/channelRegistry'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import AgentMessageParts from '@/components/AgentMessageParts.vue'
import ChatMessageActions from '@/components/ChatMessageActions.vue'
import ChatMessageParts from '@/components/ChatMessageParts.vue'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import SessionAssistantBubble from '@/components/SessionAssistantBubble.vue'
import SessionUserBubble from '@/components/SessionUserBubble.vue'
import { Button } from '@/components/ui/button'
import { copyToClipboard, messageText } from '@/lib/chatMessageText'
import { fillTemplate } from '@/lib/notificationLabel'
import {
  ArrowPathIcon,
  ClockIcon,
  DevicePhoneMobileIcon,
  ExclamationCircleIcon,
} from '@heroicons/vue/24/outline'

/**
 * One message of a Session, chat or agent, live or settled: the same bubbles
 * everywhere, with the answer's body drawn by the engine that produced it.
 */
const props = defineProps<{
  message: UIMessage
  engine: 'chat' | 'agent'
  /** Chat: the newest message of the live conversation. */
  last?: boolean
  /** Chat: the conversation the message belongs to, for its live status. */
  conversationKey?: string
  /** Agent: the message is being produced right now. */
  live?: boolean
  queued?: boolean
  notRun?: boolean
  canResend?: boolean
}>()

const emit = defineEmits<{ resend: [] }>()

const textInference = useTextInference()
const languages = useI18N().state
const showRagSource = ref(false)

const chatMessage = computed(() => props.message as AipgUiMessage)
const text = computed(() => messageText(props.message))
const ragSource = computed(() => chatMessage.value.metadata?.ragSource)
const origin = computed(() => (props.message.metadata as AgentMessageMetadata | undefined)?.origin)

const modelLabel = computed(() => {
  const model = chatMessage.value.metadata?.model
  if (!model) return undefined
  return model.endsWith('.gguf') ? (model.split('/').at(-1)?.split('.gguf')[0] ?? model) : model
})

type FilePart = { type: string; mediaType?: string; url?: string; filename?: string }

const fileParts = computed(() =>
  (props.message.parts as FilePart[]).filter((part) => part.type === 'file' && part.url),
)
const attachedImage = computed(
  () => fileParts.value.findLast((part) => part.mediaType?.startsWith('image/'))?.url,
)
const audioAttachments = computed(() =>
  fileParts.value
    .filter((part) => part.mediaType?.startsWith('audio/'))
    .map((part) => ({ url: part.url!, filename: part.filename })),
)

function copyText(value: string) {
  copyToClipboard(value, languages.COM_COPY_SUCCESS_TIP)
}

function withChannel(template: string, channel: ChannelKind): string {
  const name = getDescriptor(channel)?.displayName ?? channel
  return fillTemplate(template, { channel: name })
}
</script>
