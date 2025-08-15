import { defineStore } from 'pinia'
import { Ollama } from 'ollama/browser'
import { useChat } from '@ai-sdk/vue'
import { streamText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { useTextInference } from './textInference'

export const useOllama = defineStore(
  'ollama',
  () => {
    const textInference = useTextInference()

    const getModel = () =>
      createOpenAICompatible({
        name: 'model',
        baseURL: `${textInference.currentBackendUrl}/v1/`,
      }).chatModel(textInference.activeModel ?? 'deepseek-r1:1.5b')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customFetch = async (_: any, options: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = JSON.parse(options.body) as any
      console.log(m)
      const result = await streamText({
        model: getModel(),
        messages: m.messages,
        abortSignal: options.signal,
      })
      return result.toDataStreamResponse()
    }
    const ollamaDlProgress = ref<{
      status: 'idle' | 'pulling'
      totalBytes?: number
      completedBytes?: number
    }>({ status: 'idle' })
    const chat = useChat({ fetch: customFetch })

    async function generateWithAiSdk(chatContext: ChatItem[]) {
      await chat.append({
        role: 'user',
        content: chatContext[chatContext.length - 1].question,
      })
    }

    async function generate(chatContext: ChatItem[]) {
      // For Ollama, we need to set the model name in the backend URL
      const ollama = new Ollama({ host: textInference.currentBackendUrl })
      const ollamaDl = await ollama.pull({
        model: textInference.activeModel ?? 'asdf',
        stream: true,
      })
      for await (const progress of ollamaDl) {
        ollamaDlProgress.value = {
          status: 'pulling',
          totalBytes: progress.total,
          completedBytes: progress.completed,
        }
      }
      ollamaDlProgress.value = {
        status: 'idle',
      }
      await generateWithAiSdk(chatContext)
      return
    }

    return {
      ollamaDlProgress,
      chat,
      generate,
    }
  },
  {
    persist: {
      pick: [],
    },
  },
)
