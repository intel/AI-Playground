import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'

export const useUIStore = defineStore('ui', () => {
  // History modal state
  const showHistory = ref(false)

  // Model management overlay. Deliberately not tied to `promptArea.currentMode`:
  // closing it should return the user to exactly the view they were in.
  const showModelManager = ref(false)

  function openHistory() {
    showHistory.value = true
  }

  function closeHistory() {
    showHistory.value = false
  }

  function openModelManager() {
    showModelManager.value = true
  }

  function closeModelManager() {
    showModelManager.value = false
  }

  return {
    showHistory,
    openHistory,
    closeHistory,
    showModelManager,
    openModelManager,
    closeModelManager,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUIStore, import.meta.hot))
}
