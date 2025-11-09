import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useImageGenerationPresets } from "@/assets/js/store/imageGenerationPresets.ts";

export const usePromptStore = defineStore('prompt', () => {
  const imageGeneration = useImageGenerationPresets()
  const currentMode = ref<ModeType>('chat')
  const promptSubmitted = ref(false)

  const submitCallbacks = ref<Partial<Record<ModeType, (prompt: string) => void>>>({})
  const cancelCallbacks = ref<Partial<Record<ModeType, () => void>>>({})

  function getCurrentMode() {
    return currentMode.value
  }

  function setCurrentMode(mode: ModeType) {
    currentMode.value = mode

      switch (mode) {
        case 'imageGen':
          imageGeneration.activePresetName = imageGeneration.lastUsedImageGenPresetName
          break;
        case 'imageEdit':
          imageGeneration.activePresetName = imageGeneration.lastUsedImageEditPresetName
          break;
        case 'video':
          imageGeneration.activePresetName = imageGeneration.lastUsedVideoPresetName
          break;
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
