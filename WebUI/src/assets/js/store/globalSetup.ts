import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { ModelLists } from './models'
import { useModels } from './models'
import { useBackendServices } from './backendServices'

type GlobalSetupState = 'running' | 'verifyBackend' | 'setupWizard' | 'loading' | 'failed'

export const useGlobalSetup = defineStore('globalSetup', () => {
  const modelsStore = useModels()
  const backendServices = useBackendServices()

  const state = reactive<KVObject>({
    device: '',
    version: '0.0.0.1',
    modelFolderReadOnly: false,
  })

  const defaultBackendBaseUrl = ref('http://127.0.0.1:9999')

  const models = ref<ModelLists>({
    embedding: new Array<string>(),
  })

  const loadingState = ref<GlobalSetupState>('verifyBackend')
  const errorMessage = ref('')

  async function waitForAiBackend(): Promise<ApiServiceInformation> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const fromStore = backendServices.info.find((item) => item.serviceName === 'ai-backend')
      if (fromStore) return fromStore
      const services = await window.electronAPI.getServices()
      const fromIpc = services.find((item) => item.serviceName === 'ai-backend')
      if (fromIpc) return fromIpc
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('ai-backend service not found')
  }

  async function initSetup() {
    const setupData = await window.electronAPI.getInitSetting()

    modelsStore.initPaths(setupData.modelPaths)
    models.value = setupData.modelLists

    state.version = setupData.version
    state.modelFolderReadOnly = setupData.modelFolderReadOnly
    const aiBackendInfo = await waitForAiBackend()
    defaultBackendBaseUrl.value = aiBackendInfo.baseUrl
  }

  return {
    state,
    models,
    apiHost: defaultBackendBaseUrl,
    loadingState,
    errorMessage,
    initSetup,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGlobalSetup, import.meta.hot))
}
