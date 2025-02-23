import { acceptHMRUpdate, defineStore } from 'pinia'
import { useGlobalSetup } from './globalSetup'
import { z } from 'zod'
import { useBackendServices } from './backendServices'

export const backendTypes = ['IPEX-LLM', 'LLAMA.CPP'] as const
const BackendSchema = z.enum(backendTypes)
export type Backend = z.infer<typeof BackendSchema>

const backendModelKey = {
  'IPEX-LLM': 'llm_model',
  'LLAMA.CPP': 'ggufLLM_model',
}
export const useTextInference = defineStore(
  'textInference',
  () => {
    const globalSetup = useGlobalSetup()
    const backendServices = useBackendServices()
    const backend = ref<Backend>('IPEX-LLM')
    const activeModel = ref<string | null>(null)
    const metricsEnabled = ref(false)
    const maxTokens = ref<number>(1024)

    const llamaBackendUrl = computed(() => {
      const url = backendServices.info.find(
        (item) => item.serviceName === 'llamacpp-backend',
      )?.baseUrl
      console.log('url', url)
      return url
    })

    watch([llamaBackendUrl], () => {
      console.log('llamaBackendUrl changed', llamaBackendUrl.value)
    })

    watch([activeModel], () => {
      console.log('activeModel changed', activeModel.value)
      globalSetup.applyModelSettings({ [backendModelKey[backend.value]]: activeModel.value })
    })

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
      llamaBackendUrl,
      metricsEnabled,
      toggleMetrics,
      maxTokens,
      fontSizeClass,
      nameSizeClass,
      iconSizeClass,
      isMaxSize,
      isMinSize,
      increaseFontSize,
      decreaseFontSize,
    }
  },
  {
    persist: {
      pick: ['backend', 'activeModel', 'maxTokens'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTextInference, import.meta.hot))
}
