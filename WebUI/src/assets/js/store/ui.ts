import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'

export const useUIStore = defineStore('ui', () => {
  // Model management overlay. Deliberately not tied to `promptArea.currentMode`:
  // closing it should return the user to exactly the view they were in.
  const showModelManager = ref(false)

  // Per-viewer convenience: a lost value just shows the panel expanded again.
  const sessionsPanelCollapsed = useLocalStorage('aipg.sessionsPanelCollapsed', false)

  function openModelManager() {
    showModelManager.value = true
  }

  function closeModelManager() {
    showModelManager.value = false
  }

  return {
    sessionsPanelCollapsed,
    showModelManager,
    openModelManager,
    closeModelManager,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUIStore, import.meta.hot))
}
