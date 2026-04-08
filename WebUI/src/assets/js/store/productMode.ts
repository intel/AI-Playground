import { acceptHMRUpdate, defineStore } from 'pinia'
import { useBackendServices } from './backendServices'
import { useGlobalSetup } from './globalSetup'

export const useProductMode = defineStore('productMode', () => {
  const productMode = ref<ProductMode | null>(null)
  const hardwareRecommendation = ref<HardwareRecommendationResult | null>(null)

  async function hydrateFromMain() {
    try {
      const s = await window.electronAPI.getLocalSettings()
      productMode.value = s.productMode ?? null
    } catch (e) {
      console.error('Failed to hydrate product mode from main:', e)
      productMode.value = null
    }
  }

  async function syncToMain() {
    if (productMode.value) {
      await window.electronAPI.updateLocalSettings({ productMode: productMode.value })
    }
  }

  async function detectRecommendation() {
    try {
      hardwareRecommendation.value = await window.electronAPI.detectHardwareForModeRecommendation()
    } catch (e) {
      console.warn('Hardware detection failed, defaulting to studio recommendation:', e)
      hardwareRecommendation.value = {
        success: false,
        recommendedMode: 'studio',
        detectedDevices: [],
      }
    }
  }

  async function selectMode(mode: ProductMode) {
    productMode.value = mode
    await syncToMain()
  }

  async function ensureReady(): Promise<'ready' | 'needsSelection' | 'installFailed'> {
    const globalSetup = useGlobalSetup()
    const backendServices = useBackendServices()

    await hydrateFromMain()

    const aiBackend = backendServices.info.find((s) => s.serviceName === 'ai-backend')
    if (aiBackend && !aiBackend.isSetUp) {
      globalSetup.loadingState = 'autoInstalling'
      console.log('Auto-installing ai-backend service')
      const result = await backendServices.setUpService('ai-backend')
      if (!result.success) {
        console.error('Failed to auto-install ai-backend:', result.errorDetails)
        return 'installFailed'
      }
      await backendServices.startService('ai-backend')
    }

    if (!productMode.value) {
      globalSetup.loadingState = 'autoInstalling'
      await detectRecommendation()
      return 'needsSelection'
    }

    await syncToMain()
    return 'ready'
  }

  return {
    productMode,
    hardwareRecommendation,
    hydrateFromMain,
    syncToMain,
    detectRecommendation,
    selectMode,
    ensureReady,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProductMode, import.meta.hot))
}
