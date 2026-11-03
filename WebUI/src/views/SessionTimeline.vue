<template>
  <ScrollToBottomButton v-if="showScrollButton" @click="scrollToBottom()" />
  <div id="chatPanel" ref="panel" class="flex-1 overflow-y-auto px-4 py-6 flex flex-col relative">
    <!-- Game Agent works on one game at a time, and what to do with that game
         belongs next to it, reachable once the timeline has scrolled past it. -->
    <div v-if="showsGameBar" class="sticky top-0 z-5 flex justify-end pl-32 pr-32">
      <GameBar />
    </div>
    <template v-if="items.length === 0 && !chatBusy">
      <AgentEmptyState v-if="inAgentMode && !agentMode.processing" />
      <div v-else class="flex-1 flex items-center justify-center text-muted-foreground text-center">
        {{ languages.SESSION_TIMELINE_EMPTY }}
      </div>
    </template>
    <div v-else class="w-full max-w-4xl mx-auto flex flex-col gap-6">
      <SessionTurnBlock
        v-for="item in items"
        :key="item.id"
        :item="item"
        :last-chat-message-id="lastChatMessageId"
        :chat-key="chatKey"
        @resend="agentMode.resendNotRun()"
      />
      <!-- The chat turn's status before its answer bubble exists (backend and model prep). -->
      <ChatActivityIndicator
        v-if="chatActivity && !chatAnswerShown"
        :conversation-key="chatKey"
        with-avatar
      />
      <ChatConfirmation
        v-if="chatConfirmation && !chatAnswerShown"
        :conversation-key="chatKey"
        with-avatar
      />
    </div>
    <div
      v-if="showsAgentStatus"
      class="w-full max-w-4xl mx-auto flex flex-col gap-4"
      :class="{ 'mt-4': items.length }"
    >
      <AgentTurnStatus />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useActivities } from '@/assets/js/store/activities'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useConfirmations } from '@/assets/js/store/confirmations'
import { useConversations } from '@/assets/js/store/conversations'
import { useI18N } from '@/assets/js/store/i18n'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useSessionAudio } from '@/assets/js/store/sessionAudio'
import { useSessions } from '@/assets/js/store/sessions'
import AgentEmptyState from '@/components/AgentEmptyState.vue'
import AgentTurnStatus from '@/components/AgentTurnStatus.vue'
import ChatActivityIndicator from '@/components/ChatActivityIndicator.vue'
import ChatConfirmation from '@/components/ChatConfirmation.vue'
import GameBar from '@/components/GameBar.vue'
import ScrollToBottomButton from '@/components/ScrollToBottomButton.vue'
import SessionTurnBlock from '@/components/SessionTurnBlock.vue'
import { sessionChatKey } from '@/lib/sessionChat'
import { sessionTimelineItems } from '@/lib/sessionTimeline'
import { useStickToBottom } from '@/lib/useStickToBottom'

/**
 * The main area for a Session in every mode: each turn of its timeline, settled or
 * still running, drawn the same way whichever preset is active.
 */
const sessions = useSessions()
const chat = useOpenAiCompatibleChat()
const agentMode = useAgentMode()
const sessionAudio = useSessionAudio()
const promptStore = usePromptStore()
const activities = useActivities()
const confirmations = useConfirmations()
const conversations = useConversations()
const languages = useI18N().state
const panel = ref<HTMLElement | null>(null)

const chatKey = computed(() => sessionChatKey(sessions.openSessionId ?? ''))
const chatLive = computed(() => {
  if (!sessions.openSessionId) return []
  if (conversations.activeKey === chatKey.value) return chat.messages ?? []
  return chat.getMessagesForKey(chatKey.value) ?? []
})
const agentLive = computed(() =>
  sessions.openSessionId ? agentMode.liveTurnsIn(sessions.openSessionId) : [],
)

const items = computed(() =>
  sessionTimelineItems(sessions.openTimeline, {
    chat: chatLive.value,
    agents: agentLive.value,
    media: sessions.openSessionId ? sessions.pendingTurns[sessions.openSessionId] : null,
    audio: sessionAudio.pendingTurn,
  }),
)

const lastChatMessageId = computed(() => chatLive.value.at(-1)?.id)
const chatAnswerShown = computed(() => chatLive.value.at(-1)?.role === 'assistant')
const chatActivity = computed(() => activities.chatActivity(chatKey.value, ['generation']) !== null)
const chatConfirmation = computed(() => confirmations.forConversation(chatKey.value) !== null)
const chatBusy = computed(() => chatActivity.value || chatConfirmation.value)

const inAgentMode = computed(() => promptStore.getCurrentMode() === 'agent')
const openHarnessInSession = computed(() =>
  agentLive.value.some((turn) => turn.tag.harnessSessionId === agentMode.openSessionId),
)
const showsGameBar = computed(() => inAgentMode.value && agentMode.agentWorkspaceKind === 'games')
const showsAgentStatus = computed(
  () => openHarnessInSession.value && (inAgentMode.value || agentMode.processing),
)

const { showScrollButton, scrollToBottom } = useStickToBottom(panel)

watch(
  () => sessions.openSessionId,
  () => nextTick(() => scrollToBottom(false)),
)

onMounted(() => scrollToBottom(false))

defineExpose({ scrollToBottom })
</script>
