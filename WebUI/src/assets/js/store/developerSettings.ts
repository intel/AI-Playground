import { defineStore } from 'pinia'
import { ref } from 'vue'
import { acceptHMRUpdate } from 'pinia'

export const useDeveloperSettings = defineStore(
  'developerSettings',
  () => {
    const openDevConsoleOnStartup = ref(false)
    const keepModelsLoaded = ref(false)

    return {
      openDevConsoleOnStartup,
      keepModelsLoaded,
    }
  },
  {
    persist: {
      pick: ['openDevConsoleOnStartup', 'keepModelsLoaded'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDeveloperSettings, import.meta.hot))
}
