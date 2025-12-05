import { acceptHMRUpdate, defineStore } from 'pinia'
import { LlmBackend } from './textInference'
import { useBackendServices } from './backendServices'

export type ModelPaths = {
  ggufLLM: string
  openvinoLLM: string
  embedding: string
} & StringKV

export type ModelLists = {
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
    
    // Model paths - single source of truth for model directory locations
    const paths = ref<ModelPaths>({
      ggufLLM: '',
      openvinoLLM: '',
      embedding: '',
    })

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

    /**
     * Maps model type and backend to the appropriate ModelPaths entry
     * @param type - Model type (e.g., 'ggufLLM', 'checkpoints', 'embedding')
     * @param backend - Backend name (e.g., 'llama_cpp', 'comfyui', 'openvino')
     * @param modelPaths - Optional ModelPaths override, defaults to store's paths
     */
    function getModelPath(type: string, backend: string, modelPaths?: ModelPaths): string {
      const pathsToUse = modelPaths || paths.value
      
      // Map ComfyUI model types
      if (backend === 'comfyui') {
        // ComfyUI types map directly to ModelPaths keys (checkpoints, vae, lora, etc.)
        return pathsToUse[type] || pathsToUse['checkpoints'] || ''
      }
      
      // Map LLM backends
      if (backend === 'llama_cpp') {
        if (type === 'ggufLLM') {
          return pathsToUse.ggufLLM || ''
        }
        if (type === 'embedding') {
          // Embedding path for llama_cpp is in embedding/llamaCPP subdirectory
          const baseEmbedding = pathsToUse.embedding || ''
          if (baseEmbedding) {
            // Append backend-specific subdirectory
            return baseEmbedding.replace(/\/embedding\/?$/, '/embedding/llamaCPP')
          }
          return ''
        }
      }
      
      if (backend === 'openvino') {
        if (type === 'openvinoLLM') {
          return pathsToUse.openvinoLLM || ''
        }
        if (type === 'embedding') {
          // Embedding path for openvino is in embedding/openVINO subdirectory
          const baseEmbedding = pathsToUse.embedding || ''
          if (baseEmbedding) {
            // Append backend-specific subdirectory
            return baseEmbedding.replace(/\/embedding\/?$/, '/embedding/openVINO')
          }
          return ''
        }
        if (type === 'STT') {
          // STT path for openvino transcription models
          return pathsToUse['STT'] || ''
        }
      }
      
      // Fallback: try to find by type directly
      return pathsToUse[type] || ''
    }

    /**
     * Check if a transcription model exists
     * @param modelName - The model name (e.g., 'OpenVINO/whisper-large-v3-int4-ov')
     * @returns Promise<boolean> - True if model exists
     */
    async function checkTranscriptionModelExists(modelName: string): Promise<boolean> {
      const checkParams = [
        {
          repo_id: modelName,
          type: 'STT',
          backend: 'openvino' as const,
        },
      ]
      const results = await checkModelAlreadyLoaded(checkParams)
      return results.length > 0 && results[0].already_loaded
    }

    /**
     * Get missing transcription model download parameters
     * @param modelName - The model name (e.g., 'OpenVINO/whisper-large-v3-int4-ov')
     * @returns Promise<DownloadModelParam[]> - Array with model if missing, empty if exists
     */
    async function getMissingTranscriptionModel(
      modelName: string,
    ): Promise<DownloadModelParam[]> {
      const exists = await checkTranscriptionModelExists(modelName)
      if (exists) {
        return []
      }

      const modelPath = getModelPath('STT', 'openvino')
      return [
        {
          repo_id: modelName,
          type: 'STT',
          backend: 'openvino',
          model_path: modelPath,
        },
      ]
    }
    
    /**
     * Initialize model paths from Electron
     */
    function initPaths(modelPaths: ModelPaths) {
      paths.value = modelPaths
    }
    
    /**
     * Update model paths and sync with Electron
     */
    async function applyPathsSettings(newPaths: ModelPaths) {
      const modelLists = await window.electronAPI.updateModelPaths(newPaths)
      paths.value = newPaths
      return modelLists
    }
    
    /**
     * Restore default model paths
     */
    async function restorePathsSettings() {
      await window.electronAPI.restorePathsSettings()
      const setupData = await window.electronAPI.getInitSetting()
      paths.value = setupData.modelPaths
      return setupData.modelLists
    }

    /**
     * Check if models are already loaded. Automatically calculates model_path from type and backend.
     * @param params - Array of model check parameters (without model_path - it's calculated automatically)
     */
    async function checkModelAlreadyLoaded(
      params: Array<{
        repo_id: string
        type: string
        backend: 'comfyui' | 'llama_cpp' | 'openvino'
        additionalLicenseLink?: string
      }>,
    ) {
      // Add model_path to each parameter before sending to backend
      const paramsWithPaths: CheckModelAlreadyLoadedParameters[] = params.map((param) => ({
        ...param,
        model_path: getModelPath(param.type, param.backend),
      }))

      const response = await fetch(`${aipgBackendUrl()}/api/checkModelAlreadyLoaded`, {
        method: 'POST',
        body: JSON.stringify({ data: paramsWithPaths }),
        headers: {
          'Content-Type': 'application/json',
        },
      })
      const parsedResponse = (await response.json()) as ApiResponse & {
        data: CheckModelAlreadyLoadedResult[]
      }
      
      // Backend doesn't return model_path in response, so we need to add it back
      return parsedResponse.data.map((result, index) => ({
        ...result,
        model_path: paramsWithPaths[index].model_path,
      }))
    }

    refreshModels()

    return {
      models,
      hfToken,
      checkTranscriptionModelExists,
      getMissingTranscriptionModel,
      hfTokenIsValid: computed(() => hfToken.value?.startsWith('hf_')),
      downloadList,
      paths,
      addModel,
      refreshModels,
      download,
      checkIfHuggingFaceUrlExists,
      checkModelAlreadyLoaded,
      getModelPath,
      initPaths,
      applyPathsSettings,
      restorePathsSettings,
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
