import { acceptHMRUpdate, defineStore } from 'pinia'
import { type LlmBackend } from './textInference'
import { useBackendServices } from './backendServices'

export type ModelType =
  | 'embedding'
  | 'stableDiffusion'
  | 'inpaint'
  | 'lora'
  | 'vae'
  | 'undefined'
  | LlmBackend

export type Model = {
  name: string
  downloaded: boolean
  type: ModelType
  default: boolean
}

const predefinedModels: Omit<Model, 'downloaded'>[] = [
  { name: 'Qwen/Qwen2-1.5B-Instruct', type: 'ipexLLM', default: false },
  { name: 'microsoft/Phi-3-mini-4k-instruct', type: 'ipexLLM', default: true },
  { name: 'mistralai/Mistral-7B-Instruct-v0.3', type: 'ipexLLM', default: false },
  { name: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', type: 'ipexLLM', default: false },
  { name: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B', type: 'ipexLLM', default: false },
  {
    name: 'bartowski/Llama-3.2-3B-Instruct-GGUF/Llama-3.2-3B-Instruct-Q4_K_S.gguf',
    type: 'llamaCPP',
    default: true,
  },
  {
    name: 'bartowski/Llama-3.2-3B-Instruct-GGUF/Llama-3.2-3B-Instruct-Q8_0.gguf',
    type: 'llamaCPP',
    default: false,
  },
  {
    name: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/Meta-Llama-3.1-8B-Instruct-Q5_K_S.gguf',
    type: 'llamaCPP',
    default: false,
  },
  {
    name: 'HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/smollm2-1.7b-instruct-q4_k_m.gguf',
    type: 'llamaCPP',
    default: false,
  },
  { name: 'OpenVINO/Phi-3.5-mini-instruct-int4-ov', type: 'openVINO', default: true },
  { name: 'OpenVINO/Phi-3-mini-4k-instruct-int4-ov', type: 'openVINO', default: false },
  { name: 'OpenVINO/DeepSeek-R1-Distill-Qwen-1.5B-int4-ov', type: 'openVINO', default: false },
  { name: 'OpenVINO/DeepSeek-R1-Distill-Qwen-7B-int4-ov', type: 'openVINO', default: false },
  { name: 'OpenVINO/Mistral-7B-Instruct-v0.2-int4-ov', type: 'openVINO', default: false },
  { name: 'OpenVINO/TinyLlama-1.1B-Chat-v1.0-int4-ov', type: 'openVINO', default: false },
]

export const useModels = defineStore(
  'models',
  () => {
    const hfToken = ref<string | undefined>(undefined)
    const models = ref<Model[]>([])
    const backendServices = useBackendServices()

    const downloadList = ref<DownloadModelParam[]>([])

    async function refreshModels() {
      const sdModels = await window.electronAPI.getDownloadedDiffusionModels()
      const llmModels = await window.electronAPI.getDownloadedLLMs()
      const ggufModels = await window.electronAPI.getDownloadedGGUFLLMs()
      const openVINOLLMModels = await window.electronAPI.getDownloadedOpenVINOLLMModels()
      const loraModels = await window.electronAPI.getDownloadedLoras()
      const inpaintModels = await window.electronAPI.getDownloadedInpaintModels()
      const embeddingModels = await window.electronAPI.getDownloadedEmbeddingModels()

      const downloadedModels = [
        ...sdModels.map<{ name: string; type: ModelType }>((name) => ({
          name,
          type: 'stableDiffusion',
        })),
        ...llmModels.map<{ name: string; type: ModelType }>((name) => ({ name, type: 'ipexLLM' })),
        ...ggufModels.map<{ name: string; type: ModelType }>((name) => ({
          name,
          type: 'llamaCPP',
        })),
        ...openVINOLLMModels.map<{ name: string; type: ModelType }>((name) => ({
          name,
          type: 'openVINO',
        })),
        ...loraModels.map<{ name: string; type: ModelType }>((name) => ({ name, type: 'lora' })),
        ...inpaintModels.map<{ name: string; type: ModelType }>((name) => ({
          name,
          type: 'inpaint',
        })),
        ...embeddingModels.map<{ name: string; type: ModelType }>((name) => ({
          name,
          type: 'embedding',
        })),
      ]

      const notYetDownloaded = (model: { name: string }) =>
        !downloadedModels.map((m) => m.name).includes(model.name)
      const notPredefined = (model: { name: string }) =>
        !predefinedModels.map((m) => m.name).includes(model.name)

      models.value = [
        ...downloadedModels,
        ...predefinedModels.filter(notYetDownloaded),
        ...models.value.filter(notPredefined).filter(notYetDownloaded),
      ].map<Model>((m) => ({
        ...m,
        downloaded: downloadedModels.map((dm) => dm.name).includes(m.name),
        default: predefinedModels.find((pm) => pm.name === m.name)?.default ?? false,
      }))
    }

    async function download(_models: DownloadModelParam[]) {}
    async function addModel(model: Model) {
      models.value.push(model)
      await refreshModels()
    }

    const aipgBackendUrl = () => {
      const aiBackendUrl = backendServices.info.find(
        (item) => item.serviceName === 'ai-backend',
      )?.baseUrl
      if (!aiBackendUrl) throw new Error('AIPG Backend not running')
      return aiBackendUrl
    }

    async function checkIfHuggingFaceUrlExists(repo_id: string) {
      const response = await fetch(`${aipgBackendUrl()}/api/checkHFRepoExists?repo_id=${repo_id}`)
      const data = await response.json()
      return data.exists
    }

    async function checkModelAlreadyLoaded(params: CheckModelAlreadyLoadedParameters[]) {
      const response = await fetch(`${aipgBackendUrl()}/api/checkModelAlreadyLoaded`, {
        method: 'POST',
        body: JSON.stringify({ data: params }),
        headers: {
          'Content-Type': 'application/json',
        },
      })
      const parsedResponse = (await response.json()) as ApiResponse & {
        data: CheckModelAlreadyLoadedResult[]
      }
      return parsedResponse.data
    }

    refreshModels()

    return {
      models,
      hfToken,
      hfTokenIsValid: computed(() => hfToken.value?.startsWith('hf_')),
      downloadList,
      addModel,
      refreshModels,
      download,
      checkIfHuggingFaceUrlExists,
      checkModelAlreadyLoaded,
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
