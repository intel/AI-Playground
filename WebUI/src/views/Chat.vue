<template>
  <ScrollToBottomButton v-if="showScrollButton" @click="scrollToBottom()" />
  <div
    v-if="messages.length > 0 || chat.processing || hasActivity || hasConfirmation"
    id="chatPanel"
    ref="chatPanel"
    class="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6 relative"
  >
    <div class="w-full max-w-4xl mx-auto flex flex-col gap-6">
      <SessionMessage
        v-for="message in messages"
        :key="message.id"
        :message="message"
        engine="chat"
        :last="message.id === messages.at(-1)?.id"
        :conversation-key="conversations.activeKey"
      />
      <!-- The turn's status before its answer bubble exists (backend and model prep). -->
      <ChatActivityIndicator
        v-if="hasActivity && messages.at(-1)?.role !== 'assistant'"
        :conversation-key="conversations.activeKey"
        with-avatar
      />
      <ChatConfirmation
        v-if="hasConfirmation && messages.at(-1)?.role !== 'assistant'"
        :conversation-key="conversations.activeKey"
        with-avatar
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useActivities } from '@/assets/js/store/activities'
import { useConfirmations } from '@/assets/js/store/confirmations'
import { useConversations } from '@/assets/js/store/conversations'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import ChatActivityIndicator from '@/components/ChatActivityIndicator.vue'
import ChatConfirmation from '@/components/ChatConfirmation.vue'
import ScrollToBottomButton from '@/components/ScrollToBottomButton.vue'
import SessionMessage from '@/components/SessionMessage.vue'
import { useStickToBottom } from '@/lib/useStickToBottom'

/** A conversation that is not a Session's (a Home Agent thread), drawn like a Session's chat. */
const chat = useOpenAiCompatibleChat()
const conversations = useConversations()
const activities = useActivities()
const confirmations = useConfirmations()

const chatPanel = ref<HTMLElement | null>(null)
const { showScrollButton, scrollToBottom } = useStickToBottom(chatPanel)

const messages = computed(() => chat.messages ?? [])
const hasActivity = computed(
  () => activities.chatActivity(conversations.activeKey, ['generation']) !== null,
)
const hasConfirmation = computed(
  () => confirmations.forConversation(conversations.activeKey) !== null,
)

defineExpose({ scrollToBottom })
</script>
