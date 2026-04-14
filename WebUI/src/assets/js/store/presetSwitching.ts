import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { usePresets, type Preset, type ChatPreset } from './presets'
import { useTextInference } from './textInference'
import { useImageGenerationPresets } from './imageGenerationPresets'
import { usePromptStore } from './promptArea'
import { useBackendServices } from './backendServices'
import { useDialogStore } from './dialogs'
import { useI18N } from './i18n'
import { useDemoMode } from './demoMode'
import { useSetupWizard } from './setupWizard'

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
} as const

type LlmBackend = keyof typeof backendToService

/** Duplicated from promptArea to avoid pulling presetSwitching into that module's import graph. */
const MODE_TO_CATEGORIES: Record<ModeType, string[]> = {
  chat: ['chat'],
  imageGen: ['create-images'],
  imageEdit: ['edit-images'],
  video: ['create-videos'],
}

const MODE_TO_PRESET_TYPE: Record<ModeType, 'chat' | 'comfy'> = {
  chat: 'chat',
  imageGen: 'comfy',
  imageEdit: 'comfy',
  video: 'comfy',
}

/** Presets that require high system/GPU memory (24GB system or 16GB GPU) */
const HIGH_MEMORY_PRESETS = new Set([
  'Pro Image',
  'Pro 2 Image',
  'Edit By Prompt',
  'Edit by Prompt 2',
  'Image To 3D Model',
])

/** Presets for video generation (best on discrete GPUs with 16GB+ vRAM) */
const VIDEO_VRAM_PRESETS = new Set(['LTX-Video', 'Wan2.1-VACE'])

const MEMORY_ALERT_SUPPRESS_PREFIX = 'memoryAlertSuppress_'

function getMemoryAlertSuppressKey(presetName: string): string {
  return MEMORY_ALERT_SUPPRESS_PREFIX + presetName
}

function isMemoryAlertSuppressed(presetName: string): boolean {
  try {
    return localStorage.getItem(getMemoryAlertSuppressKey(presetName)) === '1'
  } catch {
    return false
  }
}

function setMemoryAlertSuppressed(presetName: string): void {
  try {
    localStorage.setItem(getMemoryAlertSuppressKey(presetName), '1')
  } catch {
    // ignore
  }
}

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
  const i18nState = useI18N().state
  const demoMode = useDemoMode()
  const setupWizard = useSetupWizard()

  // Switching state
  const isSwitching = ref(false)
  const switchingPresetName = ref<string | null>(null)
  const switchError = ref<string | null>(null)

  /**
   * Check if a chat backend is available (installed and can be started on demand)
   */
  function isBackendAvailable(backend: LlmBackend): boolean {
    const serviceName = backendToService[backend]
    const backendInfo = backendServices.info.find((s) => s.serviceName === serviceName)
    return backendInfo?.isSetUp ?? false
  }

  /**
   * Apply the preset switch (update state, variant, mode, load settings, last-used).
   * Used when no gating dialog is shown, or when user confirms the memory alert.
   */
  function applyPresetSwitch(
    preset: Preset,
    presetName: string,
    options: PresetSwitchOptions,
  ): void {
    presets.activePresetName = presetName

    if (options.variant) {
      presets.setActiveVariant(presetName, options.variant)
    } else if (preset.variants && preset.variants.length > 0) {
      const currentVariant = presets.activeVariantName[presetName]
      if (!currentVariant) {
        const firstVariant = preset.variants[0].name
        presets.setActiveVariant(presetName, firstVariant)
      }
    }

    if (!options.skipModeSwitch) {
      const mode = presetToMode(preset)
      promptStore.setModeOnly(mode)
    }

    if (preset.type === 'chat') {
      const textInference = useTextInference()
      textInference.loadSettingsForActivePreset()
    } else if (preset.type === 'comfy') {
      const imageGeneration = useImageGenerationPresets()
      imageGeneration.loadSettingsForActivePreset()
    }

    if (!options.skipLastUsedUpdate && preset.category) {
      presets.setLastUsedPreset(preset.category, presetName)
    }
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
            setupWizard.openWizard()
          })
          return { success: false, error: 'Required backend not available' }
        }
      }

      const isGatedMemoryPreset =
        preset.type === 'comfy' &&
        (HIGH_MEMORY_PRESETS.has(presetName) || VIDEO_VRAM_PRESETS.has(presetName))
      const shouldShowMemoryAlert =
        isGatedMemoryPreset && !isMemoryAlertSuppressed(presetName) && !demoMode.enabled

      if (shouldShowMemoryAlert) {
        const message = HIGH_MEMORY_PRESETS.has(presetName)
          ? i18nState.MEMORY_ALERT_HIGH_MEMORY
          : i18nState.MEMORY_ALERT_VIDEO_VRAM
        dialogStore.showWarningDialog(
          message,
          (dontShowAgain) => {
            applyPresetSwitch(preset, presetName, options)
            if (dontShowAgain) setMemoryAlertSuppressed(presetName)
            dialogStore.closeWarningDialog()
            console.log(`[PresetSwitching] Switched to preset (after confirm): ${presetName}`)
          },
          { dontShowAgainKey: presetName },
        )
        return { success: false }
      }

      applyPresetSwitch(preset, presetName, options)
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

  /**
   * After built-in preset files change (e.g. product mode), keep or replace the active preset
   * for the current UI mode without memory-alert dialogs.
   */
  async function reconcileActivePresetAfterCatalogReload(): Promise<void> {
    const mode = promptStore.currentMode
    const categories = MODE_TO_CATEGORIES[mode]
    const presetType = MODE_TO_PRESET_TYPE[mode]
    const name = presets.activePresetName
    if (name) {
      const preset = presets.presets.find((p) => p.name === name)
      if (preset && presetToMode(preset) === mode) {
        if (preset.type === 'chat') {
          useTextInference().loadSettingsForActivePreset()
        } else {
          useImageGenerationPresets().loadSettingsForActivePreset()
        }
        return
      }
    }
    await switchToLastUsedForCategory(categories, presetType, { skipModeSwitch: true })
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
    reconcileActivePresetAfterCatalogReload,

    // Utilities
    getModeForPreset,
    presetToMode,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePresetSwitching, import.meta.hot))
}
