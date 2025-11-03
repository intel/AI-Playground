import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useImageGeneration } from "@/assets/js/store/imageGeneration.ts";

export const usePromptStore = defineStore('prompt', () => {
  const imageGeneration = useImageGeneration()
  const currentMode = ref<ModeType>('chat')
  const promptSubmitted = ref(false)

  // todo: Remove this after cleaning up text inference. The text inference store should know its processing state directly, no need to track it here
  const textInferenceProcessing = ref(false)

  const submitCallbacks = ref<Partial<Record<ModeType, (prompt: string) => void>>>({})
  const cancelCallbacks = ref<Partial<Record<ModeType, () => void>>>({})

  function getCurrentMode() {
    return currentMode.value
  }

  function setCurrentMode(mode: ModeType) {
    currentMode.value = mode

      switch (mode) {
        case 'imageGen':
          imageGeneration.activeWorkflowName = imageGeneration.lastUsedImageGenWorkflowName
          break;
        case 'imageEdit':
          imageGeneration.activeWorkflowName = imageGeneration.lastUsedImageEditWorkflowName
          break;
        case 'video':
          imageGeneration.activeWorkflowName = imageGeneration.lastUsedVideoWorkflowName
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
    textInferenceProcessing,
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
