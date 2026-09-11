import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'

export const useDeveloperSettings = defineStore(
  'developerSettings',
  () => {
    // Default matches what main falls back to when nothing is stored yet: a dev
    // run opens DevTools, a packaged build does not.
    const openDevConsoleOnStartup = ref(import.meta.env.DEV)
    const keepModelsLoaded = ref(false)
    // Restricts the media tool catalogs to the dev-only dummy workflows
    // (see devPresets.ts), so a media turn finishes in seconds instead of
    // minutes. Without it, which workflow runs is up to the model.
    const forceDummyMediaWorkflows = ref(false)
    // Pi turn lifecycle + tool traffic in the app log. Lives in the main process,
    // so the value is pushed there whenever it changes (including on rehydration).
    const verboseAgentLogging = ref(import.meta.env.DEV)

    watch(verboseAgentLogging, (enabled) => window.electronAPI.setVerboseAgentLogging(enabled), {
      immediate: true,
    })

    return {
      openDevConsoleOnStartup,
      keepModelsLoaded,
      forceDummyMediaWorkflows,
      verboseAgentLogging,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [
        'openDevConsoleOnStartup',
        'keepModelsLoaded',
        'forceDummyMediaWorkflows',
        'verboseAgentLogging',
      ],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDeveloperSettings, import.meta.hot))
}
