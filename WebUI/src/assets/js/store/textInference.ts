import { acceptHMRUpdate, defineStore } from 'pinia'
import { z } from 'zod'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import * as Const from '@/assets/js/const'

export const llmBackendTypes = ['ipexLLM', 'llamaCPP', 'openVINO'] as const
const LlmBackendSchema = z.enum(llmBackendTypes)
export type LlmBackend = z.infer<typeof LlmBackendSchema>

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

export const useTextInference = defineStore(
  'textInference',
  () => {
    const backendServices = useBackendServices()
    const models = useModels()
    const backend = ref<LlmBackend>('ipexLLM')

    const selectedModels = ref<{ [key in LlmBackend]: string | null }>({
      ipexLLM: null,
      llamaCPP: null,
      openVINO: null,
    })

    const llmModels = computed(() => {
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

    const selectModel = (backend: LlmBackend, modelName: string) => {
      selectedModels.value[backend] = modelName
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

    async function getDownloadParamsForCurrentModelIfRequired() {
      if (!activeModel.value) return []
      const checkList = {
        repo_id: activeModel.value,
        type: backendToAipgModelTypeNumber[backend.value],
        backend: backendToAipgBackendName[backend.value],
      }
      const checkedModels = await models.checkModelAlreadyLoaded([checkList])
      const notYetDownloaded = checkedModels.filter((m) => !m.already_loaded)
      return notYetDownloaded
    }

    const activeModel = computed(() => {
      const newActiveModel = llmModels.value.filter((m) => m.type === backend.value).find((m) => m.active)?.name
      console.log('activeModel changed', newActiveModel)
      return newActiveModel
    })
    const metricsEnabled = ref(false)

    const currentBackendUrl = computed(
      () =>
        backendServices.info.find((item) => item.serviceName === backendToService[backend.value])
          ?.baseUrl,
    )

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

    return {
      backend,
      activeModel,
      selectedModels,
      llmModels,
      currentBackendUrl,
      metricsEnabled,
      fontSizeClass,
      nameSizeClass,
      iconSizeClass,
      isMaxSize,
      isMinSize,
      selectModel,
      getDownloadParamsForCurrentModelIfRequired,
      toggleMetrics,
      increaseFontSize,
      decreaseFontSize,
    }
  },
  {
    persist: {
      pick: ['backend', 'selectedModels'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTextInference, import.meta.hot))
}
