import { acceptHMRUpdate, defineStore } from 'pinia'
import { Chat } from '@ai-sdk/vue'
import { convertToModelMessages, DefaultChatTransport, streamText, UIMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { useTextInference } from './textInference'
import { useConversations } from './conversations'

export type AipgUiMessage = UIMessage<{
  reasoningStarted?: number
  reasoningFinished?: number
  model?: string
  timestamp?: number
  conversationTitle?: string
}>

export const useOpenAiCompatibleChat = defineStore(
  'openAiCompatibleChat',
  () => {
    const textInference = useTextInference()
    const conversations = useConversations()
    
    // TODO: processing state?

    const model = computed(() =>
      createOpenAICompatible({
        name: 'model',
        baseURL: `${textInference.currentBackendUrl}/v1/`,
      }).chatModel(textInference.activeModel ?? ''),
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customFetch = async (_: any, options: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = JSON.parse(options.body) as any
      let reasoningStarted: number = 0
      let reasoningFinished: number = 0
      const result = await streamText({
        model: model.value,
        messages: convertToModelMessages(m.messages),
        abortSignal: options.signal,
        system: textInference.systemPrompt,
        maxOutputTokens: textInference.maxTokens,
        onChunk: (chunk) => {
          if (chunk.chunk.type === 'reasoning-delta' && !reasoningStarted) {
            reasoningStarted = Date.now()
            console.log('Reasoning started at:', reasoningStarted)
            chunk.chunk.providerMetadata = { aipg: {reasoningStarted} }
          }
          if (chunk.chunk.type === 'text-delta' && reasoningStarted && !reasoningFinished) {
            reasoningFinished = Date.now()
            console.log('Reasoning finished at:', reasoningFinished)
            chunk.chunk.providerMetadata = { aipg: {reasoningStarted, reasoningFinished} }
          }
        }
      })
      console.log('streamText result:', result)
      return result.toUIMessageStreamResponse({
        sendReasoning: true,
        messageMetadata: (ok) => {
          if (ok.part.type === 'text-delta' || ok.part.type === 'reasoning-delta') {
          return {
              reasoningStarted: ok.part.providerMetadata?.aipg?.reasoningStarted,
              reasoningFinished: ok.part.providerMetadata?.aipg?.reasoningFinished,
            }
          }
          return {
            model: textInference.activeModel,
            timestamp: Date.now(),
          }
        }
      })
    }

    const chats: Record<string, Chat<AipgUiMessage>> = {}

    watch(
      () => conversations.activeKey,
      (activeKey) => {
        if (activeKey in chats) return
        const chat = new Chat<AipgUiMessage>({
          transport: new DefaultChatTransport({ fetch: customFetch, body: { timings_per_token: true } }),
          messages: conversations.conversationList[activeKey],
        })
        chats[activeKey] = chat
        console.log('Created new chat for key:', {activeKey, chat, messages: conversations.conversationList[activeKey]})
    })

    watch(() => chats[conversations.activeKey]?.messages, () => {
      console.log('chat messages changed:', chats[conversations.activeKey]?.messages)
    })

    const messages = computed(() => chats[conversations.activeKey]?.messages)

    const messageInput = ref('')
    const fileInput = ref<FileList | null>(null)

    async function generate() {
      await textInference.prepareBackendIfNeeded()
      console.log('before generate', {chat: chats[conversations.activeKey], messages: chats[conversations.activeKey]?.messages})
      await chats[conversations.activeKey]?.sendMessage({
        text: messageInput.value,
        files: fileInput.value ? fileInput.value : undefined,
        metadata: {
          model: textInference.activeModel,
          timestamp: Date.now(),
        },
      })
      messageInput.value = ''
      fileInput.value = null
      console.log('after generate', {chat: chats[conversations.activeKey], messages: chats[conversations.activeKey]?.messages})
      return
    }

    return {
      chat: chats[conversations.activeKey],
      messages,
      messageInput,
      fileInput,
      generate,
    }
  },
  {
    persist: {
      pick: [],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useOpenAiCompatibleChat, import.meta.hot))
}
