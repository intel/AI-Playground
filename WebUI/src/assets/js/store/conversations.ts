import { acceptHMRUpdate, defineStore } from 'pinia'
import { AipgUiMessage } from './openAiCompatibleChat'
import { A } from 'ollama/dist/shared/ollama.27169772.mjs'

export const useConversations = defineStore(
  'conversations',
  () => {
    const conversationList = ref<Record<string, AipgUiMessage[]>>({})
    const activeKey = ref('')
    const activeConversation = computed(() => conversationList.value[activeKey.value])

    function updateConversation(messages: AipgUiMessage[], conversationKey: string) {
      conversationList.value[conversationKey] = [
        ...conversationList.value[conversationKey],
        ...messages,
      ]
    }

    function deleteConversation(conversationKey: string) {
      delete conversationList.value[conversationKey]
    }

    function clearConversation(conversationKey: string) {
      conversationList.value[conversationKey] = []
    }

    function renameConversationTitle(conversationKey: string, newTitle: string) {
      const conversation = conversationList.value[conversationKey]
      if (!conversation || conversation.length === 0) return
      const firstMessage = conversation[0]
      firstMessage.metadata = {
        ...firstMessage.metadata,
        conversationTitle: newTitle,
      }
    }

    function addNewConversation() {
      const list = conversationList.value
      const newKey = addNewConversationIfLatestIsNotEmpty(list)
      activeKey.value = newKey
      return newKey
    }

    const isNewConversation = (key: string) => conversationList.value[key].length === 0

    watchEffect(() => {
      if (Object.keys(conversationList.value).includes(activeKey.value)) return
      const latestConversationKey = Object.keys(conversationList.value).at(-1)
      if (!latestConversationKey) return
      activeKey.value = latestConversationKey
    })

    return {
      conversationList,
      activeKey,
      activeConversation,
      deleteConversation,
      clearConversation,
      isNewConversation,
      updateConversation,
      renameConversationTitle,
      addNewConversation,
    }
  },
  {
    persist: {
      pick: ['conversationList'],
      afterHydrate: (ctx) =>
        addNewConversationIfLatestIsNotEmpty(ctx.store.$state.conversationList),
    },
  },
)

function addNewConversationIfLatestIsNotEmpty(
  list: Record<string, AipgUiMessage[]>,
  conversationKey?: string,
): string {
  console.log('Checking if new conversation is needed', {list, conversationKey})

  const lastKey = Object.keys(list).at(-1)
  if (lastKey && list[lastKey].length === 0) {
    return lastKey
  }

  const newKey = new Date().getTime().toString()
  list[newKey] = []
  return newKey
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConversations, import.meta.hot))
}
