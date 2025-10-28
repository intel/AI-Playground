import { acceptHMRUpdate, defineStore } from 'pinia'
import { Ollama } from 'ollama/browser'
import { useTextInference } from './textInference'

export const useOllama = defineStore(
  'ollama',
  () => {
    const textInference = useTextInference()
    const ollamaDlProgress = ref<{
      status: 'idle' | 'pulling'
      totalBytes?: number
      completedBytes?: number
    }>({ status: 'idle' })
    const pullOllamaModel = async () => {
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
      return
    }

    return {
      ollamaDlProgress,
      pullOllamaModel,
    }
  },
  {
    persist: {
      pick: [],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useOllama, import.meta.hot))
}
