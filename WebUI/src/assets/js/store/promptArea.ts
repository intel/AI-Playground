import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usePresetSwitching } from './presetSwitching'
import { useBackendServices } from './backendServices'
import { useDialogStore } from './dialogs'
import { useSetupWizard } from './setupWizard'

/**
 * Maps a mode to its corresponding preset categories.
 */
const modeToCategories: Record<ModeType, string[]> = {
  chat: ['chat'],
  imageGen: ['create-images'],
  imageEdit: ['edit-images'],
  video: ['create-videos'],
}

/**
 * Maps a mode to its corresponding preset type.
 */
const modeToPresetType: Record<ModeType, 'chat' | 'comfy'> = {
  chat: 'chat',
  imageGen: 'comfy',
  imageEdit: 'comfy',
  video: 'comfy',
}

export const usePromptStore = defineStore('prompt', () => {
  const setupWizard = useSetupWizard()

  const currentMode = ref<ModeType>('chat')
  // The mode the user last deliberately selected from the UI (mode buttons /
  // navigation). Unlike `currentMode`, this is NOT touched by background flips
  // via `setModeOnly` (agentic tool use, Home Agent turns), so UI that should
  // reflect the user's chosen context can stay stable while a tool temporarily
  // switches the app to a ComfyUI mode under the hood.
  const userSelectedMode = ref<ModeType>('chat')
  const promptSubmitted = ref(false)
  const injectedPromptText = ref<string | null>(null)

  const submitCallbacks = ref<Partial<Record<ModeType, (prompt: string) => void>>>({})
  const cancelCallbacks = ref<Partial<Record<ModeType, () => void>>>({})

  function getCurrentMode() {
    return currentMode.value
  }

  /**
   * Set the current mode as a deliberate user selection and switch to the
   * last-used preset for that mode (via the preset switching orchestrator).
   * With `skipPresetSwitch` the caller selects the preset itself (quick picker).
   * Returns false when the mode is unavailable (ComfyUI missing → install
   * warning shown) and nothing was changed.
   */
  function setCurrentMode(mode: ModeType, options: { skipPresetSwitch?: boolean } = {}): boolean {
    const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']
    if (comfyUiModes.includes(mode)) {
      const backendServices = useBackendServices()
      const servicesLoaded = backendServices.serviceInfoUpdateReceived
      const comfyUIService = backendServices.info.find((s) => s.serviceName === 'comfyui-backend')

      if (servicesLoaded && comfyUIService && comfyUIService.isSetUp === false) {
        const dialogStore = useDialogStore()

        dialogStore.showWarningDialog(
          `This mode requires you to have the ComfyUI backend component installed. You can choose **Confirm** to install now or **Cancel** to install later from App Settings.`,
          () => {
            setupWizard.openWizard()
            dialogStore.closeWarningDialog()
          },
        )
        return false
      }
    }

    const presetSwitching = usePresetSwitching()

    // Set the mode first. This is the genuine foreground path, so also record it
    // as the user's selected mode.
    currentMode.value = mode
    userSelectedMode.value = mode

    if (!options.skipPresetSwitch) {
      // Get categories for this mode
      const categories = modeToCategories[mode]
      const presetType = modeToPresetType[mode]

      // Switch to last-used preset for this mode using orchestrator
      presetSwitching.switchToLastUsedForCategory(categories, presetType, {
        skipModeSwitch: true, // We already set the mode above
      })
    }
    return true
  }

  function submitPrompt(promptText: string) {
    const callback = submitCallbacks.value[currentMode.value]
    if (callback) {
      promptSubmitted.value = true
      callback(promptText)
    }
  }

  function cancelProcessing() {
    const callback = cancelCallbacks.value[currentMode.value]
    if (callback) {
      promptSubmitted.value = false
      callback()
    }
  }

  function registerSubmitCallback(mode: ModeType, callback: (prompt: string) => void) {
    submitCallbacks.value[mode] = callback
  }

  function unregisterSubmitCallback(mode: ModeType) {
    delete submitCallbacks.value[mode]
  }

  function registerCancelCallback(mode: ModeType, callback: () => void) {
    cancelCallbacks.value[mode] = callback
  }

  function unregisterCancelCallback(mode: ModeType) {
    delete cancelCallbacks.value[mode]
  }

  /**
   * Set the current mode without triggering preset switching.
   * Used by the preset switching orchestrator when it handles preset selection itself.
   */
  function setModeOnly(mode: ModeType) {
    currentMode.value = mode
  }

  function injectPromptText(text: string) {
    injectedPromptText.value = text
  }

  return {
    currentMode,
    userSelectedMode,
    promptSubmitted,
    injectedPromptText,
    getCurrentMode,
    setCurrentMode,
    setModeOnly,
    submitPrompt,
    cancelProcessing,
    registerSubmitCallback,
    unregisterSubmitCallback,
    registerCancelCallback,
    unregisterCancelCallback,
    injectPromptText,
  }
})
