import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { usePresets, type Preset, type ChatPreset } from './presets'
import { useTextInference } from './textInference'
import { useImageGenerationPresets } from './imageGenerationPresets'
import { usePromptStore } from './promptArea'
import { useBackendServices } from './backendServices'
import { useDialogStore } from './dialogs'
import { useGlobalSetup } from './globalSetup'
import { useI18N } from './i18n'

/**
 * Maps a preset to its corresponding UI mode based on type and category.
 */
function presetToMode(preset: Preset): ModeType {
  if (preset.type === 'chat') {
    return 'chat'
  }

  // ComfyUI presets - map by category
  switch (preset.category) {
    case 'create-images':
      return 'imageGen'
    case 'edit-images':
      return 'imageEdit'
    case 'create-videos':
      return 'video'
    default:
      // Default to imageGen for unknown categories
      return 'imageGen'
  }
}

/**
 * Backend service name mapping for chat presets
 */
const backendToService = {
  llamaCPP: 'llamacpp-backend',
  openVINO: 'openvino-backend',
  ollama: 'ollama-backend',
} as const

type LlmBackend = keyof typeof backendToService

export type PresetSwitchOptions = {
  /** Specific variant to select */
  variant?: string
  /** Skip mode switching (useful when called from mode switch itself) */
  skipModeSwitch?: boolean
  /** Don't update last-used tracking */
  skipLastUsedUpdate?: boolean
}

export const usePresetSwitching = defineStore('presetSwitching', () => {
  const presets = usePresets()
  const promptStore = usePromptStore()
  const backendServices = useBackendServices()
  const dialogStore = useDialogStore()
  const globalSetup = useGlobalSetup()
  const i18nState = useI18N().state

  // Switching state
  const isSwitching = ref(false)
  const switchingPresetName = ref<string | null>(null)
  const switchError = ref<string | null>(null)

  /**
   * Check if a chat backend is available (running or can be started)
   */
  function isBackendAvailable(backend: LlmBackend): boolean {
    const serviceName = backendToService[backend]
    const backendInfo = backendServices.info.find((s) => s.serviceName === serviceName)
    return backendInfo ? backendInfo.status === 'running' || backendInfo.status === 'stopped' : false
  }

  /**
   * Unified preset switching function.
   * This is the single entry point for all preset switches in the application.
   */
  async function switchPreset(
    presetName: string,
    options: PresetSwitchOptions = {},
  ): Promise<{ success: boolean; error?: string }> {
    // Prevent concurrent switches
    if (isSwitching.value) {
      return { success: false, error: 'Preset switch already in progress' }
    }

    isSwitching.value = true
    switchingPresetName.value = presetName
    switchError.value = null

    try {
      // 1. Find the preset
      const preset = presets.presets.find((p) => p.name === presetName)
      if (!preset) {
        throw new Error(`Preset not found: ${presetName}`)
      }

      // 2. For chat presets, verify backend availability
      if (preset.type === 'chat') {
        const chatPreset = preset as ChatPreset
        const hasAvailableBackend = chatPreset.backends.some((b) => isBackendAvailable(b))

        if (!hasAvailableBackend) {
          dialogStore.showWarningDialog(i18nState.SETTINGS_MODEL_REQUIREMENTS_NOT_MET, () => {
            globalSetup.loadingState = 'manageInstallations'
          })
          return { success: false, error: 'Required backend not available' }
        }
      }

      // 3. Update central state
      presets.activePresetName = presetName

      // 4. Set variant if specified, or auto-select first variant if preset has variants
      if (options.variant) {
        presets.setActiveVariant(presetName, options.variant)
      } else if (preset.variants && preset.variants.length > 0) {
        const currentVariant = presets.activeVariantName[presetName]
        if (!currentVariant) {
          const firstVariant = preset.variants[0].name
          presets.setActiveVariant(presetName, firstVariant)
        }
      }

      // 5. Switch mode based on preset type (unless skipped)
      if (!options.skipModeSwitch) {
        const mode = presetToMode(preset)
        // Use setModeOnly to avoid triggering the preset-loading logic in setCurrentMode
        promptStore.setModeOnly(mode)
      }

      // 6. Load settings based on preset type (backend preparation deferred to inference time)
      if (preset.type === 'chat') {
        const textInference = useTextInference()
        textInference.loadSettingsForActivePreset()
      } else if (preset.type === 'comfy') {
        const imageGeneration = useImageGenerationPresets()
        imageGeneration.loadSettingsForActivePreset()
      }

      // 7. Update last-used tracking (unless skipped)
      if (!options.skipLastUsedUpdate && preset.category) {
        presets.setLastUsedPreset(preset.category, presetName)
      }

      console.log(`[PresetSwitching] Successfully switched to preset: ${presetName}`)
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
      console.error(`[PresetSwitching] Failed to switch preset: ${errorMessage}`)
      switchError.value = errorMessage
      return { success: false, error: errorMessage }
    } finally {
      isSwitching.value = false
      switchingPresetName.value = null
    }
  }

  /**
   * Switch to a specific variant of the current preset.
   */
  async function switchVariant(
    variantName: string,
    options: Omit<PresetSwitchOptions, 'variant'> = {},
  ): Promise<{ success: boolean; error?: string }> {
    const currentPresetName = presets.activePresetName
    if (!currentPresetName) {
      return { success: false, error: 'No active preset' }
    }

    return switchPreset(currentPresetName, { ...options, variant: variantName })
  }

  /**
   * Switch to the last-used preset for a given category/mode.
   * Falls back to the first preset in that category if no last-used exists.
   */
  async function switchToLastUsedForCategory(
    categories: string[],
    presetType?: 'chat' | 'comfy',
    options: PresetSwitchOptions = {},
  ): Promise<{ success: boolean; error?: string }> {
    // Try to find last-used preset
    const lastUsed = presets.getLastUsedPreset(categories)
    if (lastUsed) {
      return switchPreset(lastUsed, options)
    }

    // Fallback to first preset in category
    const presetsInCategory = presets.getPresetsByCategories(categories, presetType)
    if (presetsInCategory.length > 0) {
      return switchPreset(presetsInCategory[0].name, options)
    }

    return { success: false, error: 'No presets found for category' }
  }

  /**
   * Get the mode that would be activated for a given preset.
   */
  function getModeForPreset(presetName: string): ModeType | null {
    const preset = presets.presets.find((p) => p.name === presetName)
    if (!preset) return null
    return presetToMode(preset)
  }

  return {
    // State
    isSwitching: computed(() => isSwitching.value),
    switchingPresetName: computed(() => switchingPresetName.value),
    switchError: computed(() => switchError.value),

    // Actions
    switchPreset,
    switchVariant,
    switchToLastUsedForCategory,

    // Utilities
    getModeForPreset,
    presetToMode,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePresetSwitching, import.meta.hot))
}
