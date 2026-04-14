import { acceptHMRUpdate, defineStore } from 'pinia'

export const useProductMode = defineStore('productMode', () => {
  const productMode = ref<ProductMode | null>(null)
  const hardwareRecommendation = ref<HardwareRecommendationResult | null>(null)
  const isNvidiaModeAvailable = computed(
    () => (hardwareRecommendation.value?.hasNvidiaGpu ?? false) === true,
  )
  const isNvidiaModeSelected = computed(() => productMode.value === 'nvidia')

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
        hasNvidiaGpu: false,
        modeCatalog: [],
      }
    }
  }

  async function selectMode(mode: ProductMode) {
    productMode.value = mode
    await syncToMain()
  }

  async function ensureReady(): Promise<'ready' | 'needsSelection'> {
    await hydrateFromMain()

    if (!productMode.value) {
      await detectRecommendation()
      return 'needsSelection'
    }

    await syncToMain()
    return 'ready'
  }

  return {
    productMode,
    hardwareRecommendation,
    isNvidiaModeAvailable,
    isNvidiaModeSelected,
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
