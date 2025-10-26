import { defineStore } from 'pinia'
import { ref } from 'vue'

// todo: Consider adding "add-l-l-m-dialog" as well
export const useDialogStore = defineStore('dialog', () => {
  // Warning dialog state
  const warningDialogVisible = ref(false)
  const warningMessage = ref('')
  const warningConfirmFunction = ref(() => {})

  // Download dialog state
  const downloadDialogVisible = ref(false)
  const downloadList = ref<DownloadModelParam[]>([])
  const downloadSuccessFunction = ref<(() => void) | undefined>(undefined)
  const downloadFailFunction = ref<((args: DownloadFailedParams) => void) | undefined>(undefined)

  function showWarningDialog(message: string, func: () => void) {
    warningMessage.value = message
    warningConfirmFunction.value = func
    warningDialogVisible.value = true
  }

  function closeWarningDialog() {
    warningDialogVisible.value = false
  }

  function showDownloadDialog(
    downList: DownloadModelParam[],
    success?: () => void,
    fail?: (args: DownloadFailedParams) => void,
  ) {
    downloadList.value = downList
    downloadSuccessFunction.value = success
    downloadFailFunction.value = fail
    downloadDialogVisible.value = true
  }

  function closeDownloadDialog() {
    downloadDialogVisible.value = false
  }

  return {
    // Warning dialog
    warningDialogVisible,
    warningMessage,
    warningConfirmFunction,
    showWarningDialog,
    closeWarningDialog,

    // Download dialog
    downloadDialogVisible,
    downloadList,
    downloadSuccessFunction,
    downloadFailFunction,
    showDownloadDialog,
    closeDownloadDialog,
  }
})
