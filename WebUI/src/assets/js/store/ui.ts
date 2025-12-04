import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUIStore = defineStore('ui', () => {
  // History modal state
  const showHistory = ref(false)

  function openHistory() {
    showHistory.value = true
  }

  function closeHistory() {
    showHistory.value = false
  }

  return {
    showHistory,
    openHistory,
    closeHistory,
  }
})
