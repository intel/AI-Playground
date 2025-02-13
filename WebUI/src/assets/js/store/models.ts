import { acceptHMRUpdate, defineStore } from 'pinia'

export type ModelType =
  | 'llm'
  | 'embedding'
  | 'stableDiffusion'
  | 'inpaint'
  | 'lora'
  | 'vae'
  | 'undefined'
  | 'ggufLLM'
  | 'openvinoLLM'

export type Model = {
  name: string
  downloaded: boolean
  type: ModelType
}

const predefinedModels: Model[] = [
  { name: 'Qwen/Qwen2-1.5B-Instruct', type: 'llm', downloaded: false },
  { name: 'microsoft/Phi-3-mini-4k-instruct', type: 'llm', downloaded: false },
  // { name: 'meta-llama/Meta-Llama-3.1-8B-Instruct', type: 'llm', downloaded: false },
  { name: 'mistralai/Mistral-7B-Instruct-v0.3', type: 'llm', downloaded: false },
  // { name: 'google/gemma-7b', type: 'llm', downloaded: false },
  // { name: 'THUDM/chatglm3-6b', type: 'llm', downloaded: false },
  {
    name: 'bartowski/Llama-3.2-3B-Instruct-GGUF/Llama-3.2-3B-Instruct-Q4_K_S.gguf',
    type: 'ggufLLM',
    downloaded: false,
  },
  {
    name: 'bartowski/Llama-3.2-3B-Instruct-GGUF/Llama-3.2-3B-Instruct-Q8_0.gguf',
    type: 'ggufLLM',
    downloaded: false,
  },
  {
    name: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/Meta-Llama-3.1-8B-Instruct-Q5_K_S.gguf',
    type: 'ggufLLM',
    downloaded: false,
  },
  {
    name: 'HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/smollm2-1.7b-instruct-q4_k_m.gguf',
    type: 'ggufLLM',
    downloaded: false,
  },
  { name: 'OpenVINO/Phi-3-medium-4k-instruct-int4-ov', type: 'openvinoLLM', downloaded: false },
  { name: 'OpenVINO/mixtral-8x7b-instruct-v0.1-int4-ov', type: 'openvinoLLM', downloaded: false },
  { name: 'OpenVINO/Mistral-7B-Instruct-v0.2-fp16-ov', type: 'openvinoLLM', downloaded: false },
  { name: 'OpenVINO/TinyLlama-1.1B-Chat-v1.0-int4-ov', type: 'openvinoLLM', downloaded: false },
  { name: 'OpenVINO/Phi-3.5-mini-instruct-fp16-ov', type: 'openvinoLLM', downloaded: false },
]

export const userModels: Model[] = []

export const useModels = defineStore(
  'models',
  () => {
    const hfToken = ref<string | undefined>(undefined)
    const models = ref(predefinedModels)
    const llms = computed(() => models.value.filter((m) => m.type === 'llm'))

    const downloadList = ref<DownloadModelParam[]>([])
    const ggufLLMs = computed(() => models.value.filter((m) => m.type === 'ggufLLM'))

    const openVINOLLMModels = computed(() => models.value.filter((m) => m.type === 'openvinoLLM'))

    async function refreshModels() {
      const sdModels = await window.electronAPI.getDownloadedDiffusionModels()
      const llmModels = await window.electronAPI.getDownloadedLLMs()
      const ggufModels = await window.electronAPI.getDownloadedGGUFLLMs()
      const openVINOLLMModels = await window.electronAPI.getDownloadedOpenVINOLLMModels()
      const loraModels = await window.electronAPI.getDownloadedLoras()
      const inpaintModels = await window.electronAPI.getDownloadedInpaintModels()
      const embeddingModels = await window.electronAPI.getDownloadedEmbeddingModels()

      const downloadedModels = [
        ...sdModels.map<Model>((name) => ({ name, type: 'stableDiffusion', downloaded: true })),
        ...llmModels.map<Model>((name) => ({ name, type: 'llm', downloaded: true })),
        ...ggufModels.map<Model>((name) => ({ name, type: 'ggufLLM', downloaded: true })),
        ...openVINOLLMModels.map<Model>((name) => ({
          name,
          type: 'openvinoLLM',
          downloaded: true,
        })),
        ...loraModels.map<Model>((name) => ({ name, type: 'lora', downloaded: true })),
        ...inpaintModels.map<Model>((name) => ({ name, type: 'inpaint', downloaded: true })),
        ...embeddingModels.map<Model>((name) => ({ name, type: 'embedding', downloaded: true })),
      ]

      const notYetDownloaded = (model: Model) =>
        !downloadedModels.map((m) => m.name).includes(model.name)

      models.value = [
        ...downloadedModels,
        ...userModels.filter(notYetDownloaded),
        ...predefinedModels.filter(notYetDownloaded),
      ]
    }

    async function download(_models: DownloadModelParam[]) {}
    refreshModels()

    return {
      models,
      llms,
      ggufLLMs,
      openVINOLLMModels,
      hfToken,
      hfTokenIsValid: computed(() => hfToken.value?.startsWith('hf_')),
      downloadList,
      refreshModels,
      download,
    }
  },
  {
    persist: {
      pick: ['hfToken'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useModels, import.meta.hot))
}
