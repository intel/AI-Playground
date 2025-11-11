import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { usePresets, type ChatPreset } from './presets'
import { useTextInference, backendToService } from './textInference'
import { useBackendServices, type BackendServiceName } from './backendServices'
import { useGlobalSetup } from './globalSetup'
import { useDialogStore } from './dialogs'
import { useI18N } from './i18n'

export const useTextInferencePresets = defineStore(
  'textInferencePresets',
  () => {
    const presetsStore = usePresets()
    const textInference = useTextInference()
    const backendServices = useBackendServices()
    const globalSetup = useGlobalSetup()
    const dialogStore = useDialogStore()
    const i18nState = useI18N().state

    const activePreset = computed(() => {
      if (!presetsStore.activePresetName) return null
      const preset = presetsStore.presets.find((p) => p.name === presetsStore.activePresetName)
      if (preset && preset.type === 'chat') return preset as ChatPreset
      return null
    })

    // Initialize with first chat preset if available and no preset is selected
    watch(
      () => presetsStore.chatPresets,
      (chatPresets) => {
        if (chatPresets.length > 0 && !presetsStore.activePresetName) {
          // Sort by displayPriority and select the first one
          const sortedPresets = [...chatPresets].sort(
            (a, b) => (b.displayPriority || 0) - (a.displayPriority || 0),
          )
          presetsStore.activePresetName = sortedPresets[0].name
        }
      },
      { immediate: true },
    )

    async function applyPreset(preset: ChatPreset) {
      try {
        // Check if backend is running
        const serviceName = backendToService[preset.backend] as BackendServiceName
        const backendInfo = backendServices.info.find((s) => s.serviceName === serviceName)

        if (!backendInfo || backendInfo.status !== 'running') {
          dialogStore.showWarningDialog(
            i18nState.SETTINGS_MODEL_REQUIREMENTS_NOT_MET,
            () => {
              globalSetup.loadingState = 'manageInstallations'
            },
          )
          return
        }

        // Apply the preset using textInference store
        await textInference.applyChatPreset(preset)

        // Update active preset name in unified store
        presetsStore.activePresetName = preset.name

        console.log('Applied chat preset:', preset.name)
      } catch (error) {
        console.error('Failed to apply chat preset:', error)
      }
    }

    function selectPreset(presetName: string) {
      const preset = presetsStore.chatPresets.find((p) => p.name === presetName)
      if (preset) {
        applyPreset(preset)
      } else {
        console.warn(`Chat preset "${presetName}" not found`)
      }
    }

    return {
      // Computed
      activePreset,

      // Methods
      applyPreset,
      selectPreset,
    }
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTextInferencePresets, import.meta.hot))
}

