import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'

export type LeftPanel = 'history'

export const useUIStore = defineStore('ui', () => {
  const leftPanel = ref<LeftPanel | null>(null)
  const showHistory = computed(() => leftPanel.value === 'history')

  // Model management overlay. Deliberately not tied to `promptArea.currentMode`:
  // closing it should return the user to exactly the view they were in.
  const showModelManager = ref(false)
  const showGallery = ref(false)

  // Per-viewer convenience: a lost value just shows the panel expanded again.
  const sessionsPanelCollapsed = useLocalStorage('aipg.sessionsPanelCollapsed', false)

  // The right-hand settings sidebar of the current mode.
  const showSettings = ref(false)

  function openHistory() {
    leftPanel.value = 'history'
  }

  function closeHistory() {
    if (leftPanel.value === 'history') leftPanel.value = null
  }

  function openSettings() {
    showSettings.value = true
  }

  function closeSettings() {
    showSettings.value = false
  }

  function openModelManager() {
    showModelManager.value = true
  }

  function closeModelManager() {
    showModelManager.value = false
  }

  function openGallery() {
    showGallery.value = true
  }

  function closeGallery() {
    showGallery.value = false
  }

  return {
    leftPanel,
    showHistory,
    openHistory,
    closeHistory,
    sessionsPanelCollapsed,
    showSettings,
    openSettings,
    closeSettings,
    showModelManager,
    openModelManager,
    closeModelManager,
    showGallery,
    openGallery,
    closeGallery,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUIStore, import.meta.hot))
}
