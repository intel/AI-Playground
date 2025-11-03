import { acceptHMRUpdate, defineStore } from 'pinia'
import { LlmBackend } from './textInference'
import { useBackendServices } from './backendServices'

export type ModelPaths = {
  llm: string
  embedding: string
  stableDiffusion: string
  inpaint: string
  lora: string
  vae: string
} & StringKV

export type ModelLists = {
  llm: string[]
  stableDiffusion: string[]
  lora: string[]
  vae: string[]
  scheduler: string[]
  embedding: string[]
  inpaint: string[]
} & { [key: string]: Array<string> }

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
  mmproj?: string
  downloaded: boolean
  type: ModelType
  default: boolean
  backend?: LlmBackend
}

export const useModels = defineStore(
  'models',
  () => {
    const hfToken = ref<string | undefined>(undefined)
    const models = ref<Model[]>([])
    const backendServices = useBackendServices()

    const downloadList = ref<DownloadModelParam[]>([])

    async function refreshModels() {
      const predefinedModels = await window.electronAPI.loadModels()
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
        ...embeddingModels,
      ]

      const notYetDownloaded = (model: { name: string }) =>
        !downloadedModels.map((m) => m.name).includes(model.name)
      const notPredefined = (model: { name: string }) =>
        !predefinedModels.map((m) => m.name).includes(model.name)

      console.log('downloadedModels', downloadedModels)

      models.value = [
        ...downloadedModels,
        ...predefinedModels.filter(notYetDownloaded),
        ...models.value.filter(notPredefined).filter(notYetDownloaded),
      ].map<Model>((m) => ({
        ...m,
        downloaded: downloadedModels.map((dm) => dm.name).includes(m.name),
        default: predefinedModels.find((pm) => pm.name === m.name)?.default ?? false,
      }))
      console.log('Models refreshed', models.value)
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
