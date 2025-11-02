import { acceptHMRUpdate, defineStore } from 'pinia'
import { Chat } from '@ai-sdk/vue'
import { convertToModelMessages, DefaultChatTransport, streamText, UIMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { useTextInference } from './textInference'
import { useConversations } from './conversations'
import z from 'zod'

const LlamaCppRawValueTimingsSchema = z.object({
        cache_n: z.number(),
        prompt_n: z.number(),
        prompt_ms: z.number(),
        prompt_per_token_ms: z.number(),
        prompt_per_second: z.number(),
        predicted_n: z.number(),
        predicted_ms: z.number(),
        predicted_per_token_ms: z.number(),
        predicted_per_second: z.number()
    })

const LlamaCppRawValueSchema = z.object({
    choices: z.array(z.any()).optional(),
    created: z.number(),
    id: z.string(),
    model: z.string(),
    system_fingerprint: z.string().optional(),
    object: z.string().optional(),
    usage: z.object({
        completion_tokens: z.number(),
        prompt_tokens: z.number(),
        total_tokens: z.number()
    }).optional(),
    timings: LlamaCppRawValueTimingsSchema.optional(),
})

export type AipgUiMessage = UIMessage<{
  reasoningStarted?: number
  reasoningFinished?: number
  model?: string
  timestamp?: number
  conversationTitle?: string
  timings?: z.infer<typeof LlamaCppRawValueTimingsSchema>
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
        includeUsage: true,
      }).chatModel(textInference.activeModel ?? ''),
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customFetch = async (_: any, options: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = JSON.parse(options.body) as any
      let reasoningStarted: number = 0
      let reasoningFinished: number = 0
      let startOfRequestTime: number = Date.now()
      let firstTokenTime: number = 0
      let finishTime: number = 0
      let timings: z.infer<typeof LlamaCppRawValueTimingsSchema> | undefined = undefined
      const result = await streamText({
        model: model.value,
        messages: convertToModelMessages(m.messages),
        abortSignal: options.signal,
        system: textInference.systemPrompt,
        maxOutputTokens: textInference.maxTokens,
        includeRawChunks: true,
        onChunk: (chunk) => {
          if (chunk.chunk.type === 'raw') {
            console.log(chunk.chunk)
            const rawValue = LlamaCppRawValueSchema.safeParse(chunk.chunk.rawValue)
            if (rawValue.success && rawValue.data.timings) {
              timings = rawValue.data.timings
            }
          }
          if (!firstTokenTime && (chunk.chunk.type === 'reasoning-delta' || chunk.chunk.type === 'text-delta')) {
            firstTokenTime = Date.now()
          }
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
        },
        onFinish: (result) => {
          finishTime = Date.now()
          console.log('Stream finished:', result)
          if (!timings) {
             timings = {
              cache_n: result.usage?.cachedInputTokens ?? 0,
              prompt_n: result.usage?.outputTokens ?? 0,
              prompt_ms: firstTokenTime - startOfRequestTime,
              prompt_per_token_ms: result.usage?.inputTokens ? (firstTokenTime - startOfRequestTime) / result.usage.inputTokens : 0,
              prompt_per_second: result.usage?.inputTokens ? (result.usage.inputTokens / ((firstTokenTime - startOfRequestTime) / 1000)) : 0,
              predicted_n: result.usage?.outputTokens ?? 0,
              predicted_ms: finishTime - firstTokenTime,
              predicted_per_token_ms: result.usage?.outputTokens ? (finishTime - firstTokenTime) / result.usage.outputTokens : 0,
              predicted_per_second: result.usage?.outputTokens ? (result.usage.outputTokens / ((finishTime - firstTokenTime) / 1000)) : 0,
             }
          }
        }

      })
      console.log('streamText result:', result)
      return result.toUIMessageStreamResponse({
        sendReasoning: true,
        messageMetadata: (options) => {
          if (options.part.type === 'text-delta' || options.part.type === 'reasoning-delta') {
          return {
              reasoningStarted: options.part.providerMetadata?.aipg?.reasoningStarted,
              reasoningFinished: options.part.providerMetadata?.aipg?.reasoningFinished,
            }
          }
          return {
            model: textInference.activeModel,
            timestamp: Date.now(),
            timings,
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
