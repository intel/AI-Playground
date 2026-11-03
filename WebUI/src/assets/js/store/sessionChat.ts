import { acceptHMRUpdate, defineStore } from 'pinia'
import { watch } from 'vue'
import { useConversations } from '@/assets/js/store/conversations'
import { useSessions } from '@/assets/js/store/sessions'
import { useOpenAiCompatibleChat, type AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import { chatTranscriptOf, sessionChatKey } from '@/lib/sessionChat'

/**
 * Binds the chat store to the open Session: every non-agent chat preset writes
 * into the Session's one chat transcript, while Home Agent threads keep their
 * own conversations.
 */
export const useSessionChat = defineStore('sessionChat', () => {
  const sessions = useSessions()
  const conversations = useConversations()
  const chat = useOpenAiCompatibleChat()

  function returnToSessionChat(): void {
    const id = sessions.openSessionId
    if (!id) return
    const key = sessionChatKey(id)
    conversations.ensureConversationBucket(key)
    conversations.activeKey = key
  }

  watch(
    () => sessions.openSessionId,
    (id) => {
      if (!id || conversations.getThreadKind(conversations.activeKey) === 'homeAgent') return
      returnToSessionChat()
    },
    { immediate: true },
  )

  watch(
    () => [sessions.openSessionId, sessions.openTimeline] as const,
    ([id, timeline]) => {
      if (!id) return
      const key = sessionChatKey(id)
      const transcript = chatTranscriptOf(timeline) as unknown as AipgUiMessage[]
      const current = chat.getMessagesForKey(key) ?? []
      const same =
        current.length === transcript.length &&
        current.every((message, index) => message.id === transcript[index].id)
      if (!same || !(key in conversations.conversationList)) chat.loadTranscript(key, transcript)
    },
    { immediate: true },
  )

  return { returnToSessionChat }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessionChat, import.meta.hot))
}
