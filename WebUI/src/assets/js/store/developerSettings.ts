import { defineStore } from 'pinia'
import { ref } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'

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
      storage: demoAwareStorage,
      pick: ['openDevConsoleOnStartup', 'keepModelsLoaded'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDeveloperSettings, import.meta.hot))
}
