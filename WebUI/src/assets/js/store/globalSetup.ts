import { defineStore } from 'pinia'
import { ModelLists, ModelPaths } from './models'

type GlobalSetupState = 'running' | 'verifyBackend' | 'manageInstallations' | 'loading' | 'failed'

export const useGlobalSetup = defineStore('globalSetup', () => {
  const state = reactive<KVObject>({
    isAdminExec: false,
    device: '',
    version: '0.0.0.1',
  })

  const defaultBackendBaseUrl = ref('http://127.0.0.1:9999')

  const models = ref<ModelLists>({
    llm: new Array<string>(),
    embedding: new Array<string>(),
  })

  const paths = ref<ModelPaths>({
    llm: '',
    ggufLLM: '',
    embedding: '',
  })

  const loadingState = ref<GlobalSetupState>('verifyBackend')
  const errorMessage = ref('')

  async function initSetup() {
    const setupData = await window.electronAPI.getInitSetting()
    const apiServiceInformation = await window.electronAPI.getServices()
    paths.value = setupData.modelPaths
    models.value = setupData.modelLists
    state.isAdminExec = setupData.isAdminExec
    state.version = setupData.version
    const aiBackendInfo = apiServiceInformation.find((item) => item.serviceName === 'ai-backend')
    if (!aiBackendInfo) {
      throw new Error('ai-backend service not found')
    }
    defaultBackendBaseUrl.value = aiBackendInfo.baseUrl
  }

  async function applyPathsSettings(newPaths: ModelPaths) {
    models.value = await window.electronAPI.updateModelPaths(newPaths)
    paths.value = newPaths
  }

  async function restorePathsSettings() {
    await window.electronAPI.restorePathsSettings()
    const setupData = await window.electronAPI.getInitSetting()
    paths.value = setupData.modelPaths
    models.value = setupData.modelLists
  }

  return {
    state,
    models,
    paths,
    apiHost: defaultBackendBaseUrl,
    loadingState,
    errorMessage,
    initSetup,
    applyPathsSettings,
    restorePathsSettings,
  }
})
