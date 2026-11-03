<template>
  <div
    v-if="messageHasVisibleContent(message)"
    class="answer-tools flex gap-3 items-center text-muted-foreground"
  >
    <button
      class="flex items-end"
      :title="languages.COM_COPY"
      @click="copyText(messageText(message))"
    >
      <span class="svg-icon i-copy w-4 h-4"></span>
      <span class="text-xs ml-1">{{ languages.COM_COPY }}</span>
    </button>
    <button
      v-if="speakAvailable"
      class="flex items-end"
      title="Speak"
      :disabled="
        openAiCompatibleChat.processing || (preparingSpeech && speakingMessageId !== message.id)
      "
      :class="{
        'opacity-50 cursor-not-allowed':
          openAiCompatibleChat.processing || (preparingSpeech && speakingMessageId !== message.id),
      }"
      @click="toggleSpeak(message)"
    >
      <span
        v-if="preparingSpeech && speakingMessageId === message.id && !isSpeaking"
        class="svg-icon i-loading w-4 h-4 animate-spin"
        aria-hidden="true"
      ></span>
      <span
        v-else
        class="svg-icon w-4 h-4"
        :class="speakingMessageId === message.id ? 'i-stop' : 'i-speaker'"
      ></span>
      <span class="text-xs ml-1">{{
        preparingSpeech && speakingMessageId === message.id && !isSpeaking
          ? 'Starting…'
          : speakingMessageId === message.id && isSpeaking
            ? 'Stop'
            : 'Speak'
      }}</span>
    </button>
    <button
      class="flex items-end"
      :title="languages.COM_REGENERATE"
      @click="() => openAiCompatibleChat.regenerate(message.id)"
      v-if="last"
      :disabled="openAiCompatibleChat.processing"
      :class="{ 'opacity-50 cursor-not-allowed': openAiCompatibleChat.processing }"
    >
      <span class="svg-icon i-refresh w-4 h-4"></span>
      <span class="text-xs ml-1">{{ languages.COM_REGENERATE }}</span>
    </button>
    <button
      class="flex items-end"
      :title="languages.COM_DELETE"
      @click="
        () => {
          openAiCompatibleChat.removeMessage(message.id)
        }
      "
    >
      <span class="svg-icon i-delete w-4 h-4"></span>
      <span class="text-xs ml-1">{{ languages.COM_DELETE }}</span>
    </button>
  </div>
  <div
    v-if="textInference.metricsEnabled && message.metadata?.timings"
    class="metrics-info text-xs text-muted-foreground"
  >
    <span class="mr-2">{{ message.metadata?.timings.predicted_n }} Tokens</span>
    <span class="mr-2">⋅</span>
    <span class="mr-2"
      >{{ message.metadata?.timings.predicted_per_second.toFixed(2) }} Tokens/s</span
    >
    <span class="mr-2">⋅</span>
    <span class="mr-2">1st Token Time: {{ message.metadata?.timings.prompt_ms.toFixed(2) }}ms</span>
    <template v-if="message.metadata?.compute?.gpuMemPeakMiB != null">
      <span class="mr-2">⋅</span>
      <span class="mr-2">{{ formatMib(message.metadata.compute.gpuMemPeakMiB) }} vRAM peak</span>
    </template>
    <template v-else-if="message.metadata?.compute?.hostMemPeakMiB != null">
      <span class="mr-2">⋅</span>
      <span class="mr-2">{{ formatMib(message.metadata.compute.hostMemPeakMiB) }} RAM peak</span>
    </template>
    <template v-if="CHAT_ENERGY_ESTIMATES_ENABLED && message.metadata?.energy?.wattHours != null">
      <span class="mr-2">⋅</span>
      <span class="mr-2">{{ formatEnergyWh(message.metadata.energy.wattHours) }} GPU energy</span>
    </template>
    <template v-if="CHAT_ENERGY_ESTIMATES_ENABLED && last && conversationEnergy">
      <span class="mr-2">⋅</span>
      <span class="mr-2"
        >est. {{ formatUsd(conversationEnergy.costPerMillionOutputTokensUsd) }} / 1M output tokens @
        $0.35/kWh</span
      >
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useOpenAiCompatibleChat, type AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import { useTextInference } from '@/assets/js/store/textInference'
import {
  isSpeaking,
  preparingSpeech,
  speak,
  speakRepliesAvailable,
  speakingMessageId,
  stopSpeaking,
} from '@/assets/js/speech/speechIO'
import { CHAT_ENERGY_ESTIMATES_ENABLED, estimateConversationEnergy } from '@/lib/chatEnergy'
import { copyToClipboard, messageHasVisibleContent, messageText } from '@/lib/chatMessageText'
import { formatEnergyWh, formatMib, formatUsd } from '@/lib/computeMetricsFormat'

/** Copy, Speak, Regenerate and Delete under a chat answer, and its speed and memory figures. */
defineProps<{
  message: AipgUiMessage
  /** The newest message of the live conversation: the one Regenerate redoes. */
  last?: boolean
}>()

const openAiCompatibleChat = useOpenAiCompatibleChat()
const textInference = useTextInference()
const languages = useI18N().state
const speakAvailable = computed(() => speakRepliesAvailable())
const conversationEnergy = computed(() =>
  estimateConversationEnergy(openAiCompatibleChat.messages ?? []),
)

function copyText(text: string) {
  copyToClipboard(text, languages.COM_COPY_SUCCESS_TIP)
}

function toggleSpeak(message: AipgUiMessage): void {
  if (speakingMessageId.value === message.id && (isSpeaking.value || preparingSpeech.value)) {
    stopSpeaking()
    return
  }
  if (preparingSpeech.value) return
  void speak({ text: messageText(message), messageId: message.id })
}
</script>
