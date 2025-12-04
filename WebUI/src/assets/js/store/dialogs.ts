import { defineStore } from 'pinia'
import { ref } from 'vue'

// todo: Consider adding "add-l-l-m-dialog" as well
export type PresetRequirementsData = {
  missingModels: Array<{ name: string; type: string }>
  missingCustomNodes: string[]
  missingPythonPackages: string[]
}

export type InstallationPhase =
  | 'installing_python_packages'
  | 'installing_custom_nodes'
  | 'stopping_backend'
  | 'starting_backend'
  | 'downloading_models'
  | 'completed'
  | 'error'

export type InstallationProgressData = {
  currentPhase: InstallationPhase
  currentItem?: string // e.g., package name or node name
  overallProgress: number // 0-100
  completedItems: number
  totalItems: number
  statusMessage: string
  error?: string
  // For model download delegation
  showModelDownload?: boolean
  modelDownloadList?: DownloadModelParam[]
}

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

  // Preset requirements dialog state
  const presetRequirementsDialogVisible = ref(false)
  const presetRequirementsData = ref<PresetRequirementsData | null>(null)
  const presetRequirementsConfirmFunction = ref<(() => void) | undefined>(undefined)

  // Installation progress dialog state
  const installationProgressDialogVisible = ref(false)
  const installationProgressData = ref<InstallationProgressData | null>(null)

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

  function showPresetRequirementsDialog(data: PresetRequirementsData, confirmFunction: () => void) {
    presetRequirementsData.value = data
    presetRequirementsConfirmFunction.value = confirmFunction
    presetRequirementsDialogVisible.value = true
  }

  function closePresetRequirementsDialog() {
    presetRequirementsDialogVisible.value = false
    presetRequirementsData.value = null
    presetRequirementsConfirmFunction.value = undefined
  }

  function showInstallationProgressDialog(initialData: InstallationProgressData) {
    installationProgressData.value = initialData
    installationProgressDialogVisible.value = true
  }

  function updateInstallationProgress(progressData: InstallationProgressData) {
    if (installationProgressDialogVisible.value) {
      installationProgressData.value = progressData
    }
  }

  function closeInstallationProgressDialog() {
    installationProgressDialogVisible.value = false
    installationProgressData.value = null
  }

  function transitionToModelDownload(downloadList: DownloadModelParam[]) {
    // Update progress to show model download phase
    if (installationProgressData.value) {
      installationProgressData.value.currentPhase = 'downloading_models'
      installationProgressData.value.showModelDownload = true
      installationProgressData.value.modelDownloadList = downloadList
    }
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

    // Preset requirements dialog
    presetRequirementsDialogVisible,
    presetRequirementsData,
    presetRequirementsConfirmFunction,
    showPresetRequirementsDialog,
    closePresetRequirementsDialog,

    // Installation progress dialog
    installationProgressDialogVisible,
    installationProgressData,
    showInstallationProgressDialog,
    updateInstallationProgress,
    closeInstallationProgressDialog,
    transitionToModelDownload,
  }
})
