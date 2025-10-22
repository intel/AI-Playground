import { defineStore } from 'pinia'
import { ref } from 'vue'

// todo: Consider changing this to a generic "dialogStore" and add "download-dialog" and "add-l-l-m-dialog" as well
export const useWarningDialogStore = defineStore('dialog', () => {
  const showWarningDialog = ref(false)
  const warningMessage = ref('')
  const confirmFunction = ref(() => {})

  function showWarning(message: string, func: () => void) {
    warningMessage.value = message
    confirmFunction.value = func
    showWarningDialog.value = true
  }

  function closeWarning() {
    showWarningDialog.value = false
  }

  return {
    showWarningDialog,
    warningMessage,
    confirmFunction,
    showWarning,
    closeWarning
  }
})
