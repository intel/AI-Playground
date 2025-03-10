import { acceptHMRUpdate, defineStore } from 'pinia'
import { z } from 'zod'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import * as Const from '@/assets/js/const'
import { Document } from 'langchain/document'
import { useGlobalSetup } from './globalSetup'

export const llmBackendTypes = ['ipexLLM', 'llamaCPP', 'openVINO'] as const

const LlmBackendSchema = z.enum(llmBackendTypes)
export type LlmBackend = z.infer<typeof LlmBackendSchema>
type LlmBackendKV = { [key in LlmBackend]: string | null }

const backendToService = {
  ipexLLM: 'ai-backend',
  llamaCPP: 'llamacpp-backend',
  openVINO: 'openvino-backend',
} as const

export type LlmModel = {
  name: string
  type: LlmBackend
  active: boolean
  downloaded: boolean
}

export type ValidFileExtension = 'txt' | 'doc' | 'docx' | 'md' | 'pdf'

export type IndexedDocument = {
  filename: string
  filepath: string
  type: ValidFileExtension
  splitDB: Document<Record<string, any>>[]
  hash: string
  isChecked: boolean
}

export type EmbedInquiry = {
  prompt: string
  ragList: IndexedDocument[]
  backendBaseUrl: string
  embeddingModel: string | undefined
}

export const useTextInference = defineStore(
  'textInference',
  () => {
    const globalSetup = useGlobalSetup()
    const backendServices = useBackendServices()
    const models = useModels()
    const backend = ref<LlmBackend>('ipexLLM')
    const ragList = ref<IndexedDocument[]>([])

    const selectedModels = ref<LlmBackendKV>({
      ipexLLM: null,
      llamaCPP: null,
      openVINO: null,
    })

    const selectedEmbeddingModels = ref<LlmBackendKV>({
      ipexLLM: null,
      llamaCPP: null,
      openVINO: null,
    })

    const llmModels: Ref<LlmModel[]> = computed(() => {
      const llmTypeModels = models.models.filter((m) =>
        ['ipexLLM', 'llamaCPP', 'openVINO'].includes(m.type),
      )
      const newModels = llmTypeModels.map((m) => {
        const selectedModelForType = selectedModels.value[m.type as LlmBackend]
        return {
          name: m.name,
          type: m.type as LlmBackend,
          downloaded: m.downloaded,
          active:
            m.name === selectedModelForType ||
            (!llmTypeModels.some((m) => m.name === selectedModelForType) && m.default),
        }
      })
      console.log('llmModels changed', newModels)
      return newModels
    })

    const llmEmbeddingModels: Ref<LlmModel[]> = computed(() => {
      const llmEmbeddingTypeModels = models.models.filter((m) => m.type === 'embedding')
      const newEmbeddingModels = llmEmbeddingTypeModels.map((m) => {
        const selectedEmbeddingModelForType = selectedEmbeddingModels.value[m.backend as LlmBackend]
        return {
          name: m.name,
          type: m.backend as LlmBackend,
          downloaded: m.downloaded,
          active:
            m.name === selectedEmbeddingModelForType ||
            (!llmEmbeddingTypeModels.some((m) => m.name === selectedEmbeddingModelForType) &&
              m.default),
        }
      })
      console.log('llmEmbeddingModels changed', newEmbeddingModels)
      return newEmbeddingModels
    })

    const selectModel = (backend: LlmBackend, modelName: string) => {
      selectedModels.value[backend] = modelName
    }

    const selectEmbeddingModel = (backend: LlmBackend, modelName: string) => {
      selectedEmbeddingModels.value[backend] = modelName
    }

    const backendToAipgBackendName = {
      ipexLLM: 'default',
      llamaCPP: 'llama_cpp',
      openVINO: 'openvino',
    } as const

    const backendToAipgModelTypeNumber = {
      ipexLLM: Const.MODEL_TYPE_LLM,
      llamaCPP: Const.MODEL_TYPE_LLAMA_CPP,
      openVINO: Const.MODEL_TYPE_OPENVINO,
    } as const

    const activeModel: Ref<string | undefined> = computed(() => {
      const newActiveModel = llmModels.value
        .filter((m) => m.type === backend.value)
        .find((m) => m.active)?.name
      console.log('activeModel changed', newActiveModel)
      return newActiveModel
    })
    const activeEmbeddingModel: Ref<string | undefined> = computed(() => {
      const newActiveEmbeddingModel = llmEmbeddingModels.value
        .filter((m) => m.type === backend.value)
        .find((m) => m.active)?.name
      console.log(llmEmbeddingModels)
      console.log('activeEmbeddingModel changed', newActiveEmbeddingModel)
      return newActiveEmbeddingModel
    })
    const metricsEnabled = ref(false)
    const maxTokens = ref<number>(1024)

    const currentBackendUrl = computed(
      () =>
        backendServices.info.find((item) => item.serviceName === backendToService[backend.value])
          ?.baseUrl,
    )

    async function getDownloadParamsForCurrentModelIfRequired(type: 'llm' | 'embedding') {
      let model: string | undefined
      if (type === 'llm') {
        model = activeModel.value
      } else {
        model = activeEmbeddingModel.value
      }
      if (!model) return []
      const checkList = {
        repo_id: model,
        type: backendToAipgModelTypeNumber[backend.value],
        backend: backendToAipgBackendName[backend.value],
      }
      const checkedModels = await models.checkModelAlreadyLoaded([checkList])
      const notYetDownloaded = checkedModels.filter((m) => !m.already_loaded)
      return notYetDownloaded
    }

    function toggleMetrics() {
      metricsEnabled.value = !metricsEnabled.value
    }

    const fontSizeIndex = ref<number>(1)
    const fontSizes = [
      'text-xs',
      'text-sm',
      'text-base',
      'text-lg',
      'text-xl',
      'text-2xl',
      'text-3xl',
      'text-4xl',
      'text-5xl',
      'text-6xl',
      'text-7xl',
      'text-8xl',
      'text-9xl',
    ]
    const iconSizes = [
      'size-[40px]',
      'size-[42px]',
      'size-[44px]',
      'size-[46px]',
      'size-[48px]',
      'size-[50px]',
      'size-[52px]',
      'size-[54px]',
      'size-[56px]',
      'size-[58px]',
      'size-[60px]',
      'size-[62px]',
      'size-[64px]',
    ]

    const fontSizeClass = computed(() => fontSizes[fontSizeIndex.value])
    const nameSizeClass = computed(() => fontSizes[Math.max(fontSizeIndex.value - 2, 0)])
    const iconSizeClass = computed(() => iconSizes[fontSizeIndex.value])
    const isMaxSize = computed(() => fontSizeIndex.value >= fontSizes.length - 1)
    const isMinSize = computed(() => fontSizeIndex.value <= 0)

    function increaseFontSize() {
      if (!isMaxSize.value) {
        fontSizeIndex.value++
      }
    }
    function decreaseFontSize() {
      if (!isMinSize.value) {
        fontSizeIndex.value--
      }
    }

    async function addDocumentToRagList(document: IndexedDocument) {
      const langchainDocument: IndexedDocument =
        await window.electronAPI.addDocumentToRAGList(document)
      console.log(langchainDocument)
      if (ragList.value.some((item) => item.hash === langchainDocument.hash)) {
        console.log('Document already in list')
        return
      }
      ragList.value.push(langchainDocument)
    }

    async function embedInputUsingRag(prompt: string) {
      const checkedRagList = ragList.value.filter((item) => item.isChecked).map(doc => JSON.parse(JSON.stringify(doc)))
      if (checkedRagList.length === 0) {
        throw new Error('No documents selected')
      }
      if (!currentBackendUrl.value) {
        throw new Error('Backend service not found')
      }
      if (!activeEmbeddingModel.value) {
        throw new Error('No embedding model selected')
      }
      const newEmbedInquiry: EmbedInquiry = {
        prompt: prompt,
        ragList: checkedRagList,
        backendBaseUrl: currentBackendUrl.value,
        embeddingModel: activeEmbeddingModel.value,
      }
      console.log('trying to request rag for', {newEmbedInquiry, ragList: ragList.value})
      const response = await window.electronAPI.embedInputUsingRag(newEmbedInquiry)
      return response
    }

    function updateFileCheckStatus(hash: string, isChecked: boolean) {
      const index = ragList.value.findIndex((item) => item.hash === hash)
      if (index !== -1) {
        ragList.value[index].isChecked = isChecked
      }
    }

    function deleteFile(hash: string) {
      const index = ragList.value.findIndex((item) => item.hash === hash)
      if (index !== -1) {
        ragList.value.splice(index, 1)
      }
    }

    function checkAllFiles() {
      ragList.value.forEach((item) => (item.isChecked = true))
    }

    function uncheckAllFiles() {
      ragList.value.forEach((item) => (item.isChecked = false))
    }

    function deleteAllFiles() {
      ragList.value.length = 0
    }

    return {
      backend,
      activeModel,
      selectedModels,
      llmModels,
      llmEmbeddingModels,
      currentBackendUrl,
      metricsEnabled,
      maxTokens,
      fontSizeClass,
      nameSizeClass,
      iconSizeClass,
      isMaxSize,
      isMinSize,
      ragList,
      selectModel,
      selectEmbeddingModel,
      getDownloadParamsForCurrentModelIfRequired,
      toggleMetrics,
      increaseFontSize,
      decreaseFontSize,
      addDocumentToRagList,
      embedInputUsingRag,
      updateFileCheckStatus,
      deleteFile,
      checkAllFiles,
      uncheckAllFiles,
      deleteAllFiles,
    }
  },
  {
    persist: {
      pick: ['backend', 'selectedModels', 'maxTokens', 'ragList'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTextInference, import.meta.hot))
}
