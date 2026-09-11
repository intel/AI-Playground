import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { MODE_TO_CATEGORIES, MODE_TO_PRESET_TYPE } from '@/lib/presetModes'
import { usePresetSwitching } from './presetSwitching'
import { useBackendServices } from './backendServices'
import { useDialogStore } from './dialogs'
import { useSetupWizard } from './setupWizard'
import { usePresets } from './presets'

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
      const categories = MODE_TO_CATEGORIES[mode]
      const presetType = MODE_TO_PRESET_TYPE[mode]

      // Switch to last-used preset for this mode using orchestrator. The mode is
      // deliberately NOT pinned here: chat and agent share the chat category, so
      // the preset that comes back decides which of the two actually renders.
      presetSwitching.switchToLastUsedForCategory(categories, presetType)
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

  /**
   * Set the mode a freshly selected preset belongs to. Used by the preset
   * switching orchestrator on foreground switches: the preset itself may move the
   * app between Chat and Agent Mode, and that is a deliberate user choice, so
   * `userSelectedMode` follows (UI such as the status bar reads it).
   */
  function setModeForPreset(mode: ModeType) {
    currentMode.value = mode
    userSelectedMode.value = mode
  }

  function injectPromptText(text: string) {
    injectedPromptText.value = text
  }

  /**
   * Follow the persisted active preset into its mode, once the preset catalog has
   * loaded. The active preset survives a restart but the mode does not (it starts
   * at 'chat'), so without this an Audio preset selected before the last shutdown
   * would come back under the Chat mode. Only for launches with no configured
   * landing page — an explicit one wins.
   */
  function alignModeToActivePreset(): void {
    const presets = usePresets()
    const activePresetOnceLoaded = () =>
      presets.presets.length > 0 ? presets.activePresetName : null

    /** Returns whether a decision was reached (so the watcher can stop). */
    const align = (presetName: string | null): boolean => {
      if (!presetName) return false
      const mode = usePresetSwitching().getModeForPreset(presetName)
      // Only chat-type presets are followed. A stale ComfyUI preset is reconciled to
      // a chat preset on startup (see textInference), so following it would land the
      // app in a mode whose active preset is about to be replaced anyway.
      if (mode !== 'chat' && mode !== 'audio') return true
      if (mode !== currentMode.value) setCurrentMode(mode, { skipPresetSwitch: true })
      return true
    }

    if (align(activePresetOnceLoaded())) return
    const stop = watch(activePresetOnceLoaded, (presetName) => {
      if (align(presetName)) stop()
    })
  }

  return {
    currentMode,
    userSelectedMode,
    promptSubmitted,
    injectedPromptText,
    getCurrentMode,
    setCurrentMode,
    setModeOnly,
    setModeForPreset,
    submitPrompt,
    cancelProcessing,
    registerSubmitCallback,
    unregisterSubmitCallback,
    registerCancelCallback,
    unregisterCancelCallback,
    injectPromptText,
    alignModeToActivePreset,
  }
})
