import { acceptHMRUpdate, defineStore } from 'pinia'
import { LlmBackend } from './textInference'
import { useBackendServices } from './backendServices'

export type ModelPaths = {
  llm: string
  ggufLLM: string
  embedding: string
} & StringKV

export type ModelLists = {
  llm: string[]
  embedding: string[]
} & { [key: string]: Array<string> }

export type ModelType = 'embedding' | 'undefined' | LlmBackend

export type Model = {
  name: string
  mmproj?: string
  downloaded: boolean
  type: ModelType
  default: boolean
  backend?: LlmBackend
  supportsToolCalling?: boolean
  supportsVision?: boolean
  maxContextSize?: number
  npuSupport?: boolean
}

export const useModels = defineStore(
  'models',
  () => {
    const hfToken = ref<string | undefined>(undefined)
    const models = ref<Model[]>([])
    const backendServices = useBackendServices()

    const downloadList = ref<DownloadModelParam[]>([])

    async function refreshModels() {
      const predefinedModels = (await window.electronAPI.loadModels()) as Model[]
      const ggufModels = await window.electronAPI.getDownloadedGGUFLLMs()
      const openVINOLLMModels = await window.electronAPI.getDownloadedOpenVINOLLMModels()
      const embeddingModels = await window.electronAPI.getDownloadedEmbeddingModels()

      const downloadedModels = [
        ...ggufModels.map<{ name: string; type: ModelType }>((name) => ({
          name,
          type: 'llamaCPP',
        })),
        ...openVINOLLMModels.map<{ name: string; type: ModelType }>((name) => ({
          name,
          type: 'openVINO',
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
      ].map<Model>((m) => {
        const predefinedModel = predefinedModels.find((pm) => pm.name === m.name)
        const model: Model = {
          name: m.name,
          mmproj: 'mmproj' in m ? (m.mmproj as string | undefined) : undefined,
          downloaded: downloadedModels.map((dm) => dm.name).includes(m.name),
          type: m.type,
          default: predefinedModel?.default ?? false,
          backend: 'backend' in m ? (m.backend as LlmBackend | undefined) : undefined,
          supportsToolCalling: predefinedModel?.supportsToolCalling,
          supportsVision: predefinedModel?.supportsVision,
          maxContextSize: predefinedModel?.maxContextSize,
          npuSupport: predefinedModel?.npuSupport,
        }
        return model
      })
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
