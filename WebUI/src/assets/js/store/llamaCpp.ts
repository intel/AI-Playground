import { acceptHMRUpdate, defineStore } from 'pinia'
import { Chat } from '@ai-sdk/vue'
import { convertToModelMessages, DefaultChatTransport, streamText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { useTextInference } from './textInference'

export const useLlamaCpp = defineStore(
  'llamaCpp',
  () => {
    const textInference = useTextInference()

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
      const result = await streamText({
        model: model.value,
        messages: convertToModelMessages(m.messages),
        abortSignal: options.signal,
      })
      return result.toUIMessageStreamResponse({
        sendReasoning: true,
      })
    }
    const chat = new Chat({
      transport: new DefaultChatTransport({ fetch: customFetch }),
    })

    const messages = computed(() => chat.messages)
    async function generateWithAiSdk(chatContext: ChatItem[]) {
      await chat.sendMessage({
        text: chatContext[chatContext.length - 1].question,
      })
      console.log('after generate', messages.value)
    }

    async function generate(chatContext: ChatItem[]) {
      await generateWithAiSdk(chatContext)
      return
    }

    return {
      messages,
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
  import.meta.hot.accept(acceptHMRUpdate(useLlamaCpp, import.meta.hot))
}
