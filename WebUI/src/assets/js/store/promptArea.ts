import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usePresets } from "@/assets/js/store/presets";

export const usePromptStore = defineStore('prompt', () => {
  const presetsStore = usePresets()
  const currentMode = ref<ModeType>('chat')
  const promptSubmitted = ref(false)

  const submitCallbacks = ref<Partial<Record<ModeType, (prompt: string) => void>>>({})
  const cancelCallbacks = ref<Partial<Record<ModeType, () => void>>>({})

  function getCurrentMode() {
    return currentMode.value
  }

  function setCurrentMode(mode: ModeType) {
    currentMode.value = mode

    // Map modes to categories and set active preset from lastUsed
    switch (mode) {
      case 'chat': {
        const categories = ['chat']
        const lastUsed = presetsStore.getLastUsedPreset(categories)
        if (lastUsed) {
          presetsStore.activePresetName = lastUsed
        }
        break
      }
      case 'imageGen': {
        const categories = ['create-images']
        const lastUsed = presetsStore.getLastUsedPreset(categories)
        if (lastUsed) {
          presetsStore.activePresetName = lastUsed
        }
        break
      }
      case 'imageEdit': {
        const categories = ['edit-images']
        const lastUsed = presetsStore.getLastUsedPreset(categories)
        if (lastUsed) {
          presetsStore.activePresetName = lastUsed
        }
        break
      }
      case 'video': {
        const categories = ['create-videos']
        const lastUsed = presetsStore.getLastUsedPreset(categories)
        if (lastUsed) {
          presetsStore.activePresetName = lastUsed
        }
        break
      }
    }
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

  return {
    promptSubmitted,
    getCurrentMode,
    setCurrentMode,
    submitPrompt,
    cancelProcessing,
    registerSubmitCallback,
    unregisterSubmitCallback,
    registerCancelCallback,
    unregisterCancelCallback,
  }
})
