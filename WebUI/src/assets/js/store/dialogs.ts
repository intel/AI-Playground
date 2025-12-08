import { acceptHMRUpdate, defineStore } from 'pinia'
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

  // Mask editor dialog state
  const maskEditorDialogVisible = ref(false)
  const maskEditorMode = ref<'inpaint' | 'outpaint'>('inpaint')

  // Mask editor preview state
  const maskEditorOriginalImageUrl = ref<string>('')
  const maskEditorPreviewImageUrl = ref<string>('')
  const maskEditorIsModified = ref(false)

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

  function showMaskEditorDialog(mode: 'inpaint' | 'outpaint', originalImageUrl?: string) {
    maskEditorMode.value = mode
    if (originalImageUrl) {
      maskEditorOriginalImageUrl.value = originalImageUrl
    }
    maskEditorDialogVisible.value = true
  }

  function closeMaskEditorDialog() {
    maskEditorDialogVisible.value = false
  }

  function setMaskEditorOriginalImage(url: string) {
    maskEditorOriginalImageUrl.value = url
  }

  function setMaskEditorPreview(previewUrl: string) {
    maskEditorPreviewImageUrl.value = previewUrl
    maskEditorIsModified.value = true
  }

  function clearMaskEditorPreview() {
    maskEditorOriginalImageUrl.value = ''
    maskEditorPreviewImageUrl.value = ''
    maskEditorIsModified.value = false
  }

  // Regenerate outpaint preview when resolution changes
  async function regenerateOutpaintPreview(
    targetWidth: number,
    targetHeight: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ) {
    if (!maskEditorIsModified.value || maskEditorMode.value !== 'outpaint') return
    if (!maskEditorOriginalImageUrl.value) return

    // Load the original image
    const img = new Image()
    img.src = maskEditorOriginalImageUrl.value

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to load image'))
    })

    // Calculate image dimensions based on padding
    const availableWidth = targetWidth - left - right
    const availableHeight = targetHeight - top - bottom

    if (availableWidth <= 0 || availableHeight <= 0) return

    const scale = Math.min(availableWidth / img.naturalWidth, availableHeight / img.naturalHeight, 1)

    const imageWidth = img.naturalWidth * scale
    const imageHeight = img.naturalHeight * scale
    const imageX = left
    const imageY = top

    // Create a preview canvas
    const previewCanvas = document.createElement('canvas')
    previewCanvas.width = targetWidth
    previewCanvas.height = targetHeight
    const ctx = previewCanvas.getContext('2d')
    if (!ctx) return

    // Draw neutral background
    ctx.fillStyle = '#f5f5f5'
    ctx.fillRect(0, 0, targetWidth, targetHeight)

    // Draw grid (lighter for preview)
    ctx.strokeStyle = '#e8e8e8'
    ctx.lineWidth = 1
    const gridSize = 64
    for (let x = 0; x < targetWidth; x += gridSize) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, targetHeight)
      ctx.stroke()
    }
    for (let y = 0; y < targetHeight; y += gridSize) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(targetWidth, y)
      ctx.stroke()
    }

    // Draw the image
    ctx.drawImage(img, imageX, imageY, imageWidth, imageHeight)

    // Draw subtle padding indicator (lighter than main canvas)
    ctx.fillStyle = 'rgba(156, 163, 175, 0.15)'

    // Top padding
    if (imageY > 0) {
      ctx.fillRect(0, 0, targetWidth, imageY)
    }
    // Bottom padding
    const imageBottom = imageY + imageHeight
    if (imageBottom < targetHeight) {
      ctx.fillRect(0, imageBottom, targetWidth, targetHeight - imageBottom)
    }
    // Left padding
    if (imageX > 0) {
      ctx.fillRect(0, imageY, imageX, imageHeight)
    }
    // Right padding
    const imageRight = imageX + imageWidth
    if (imageRight < targetWidth) {
      ctx.fillRect(imageRight, imageY, targetWidth - imageRight, imageHeight)
    }

    // Convert to PNG data URI
    const previewDataUri = previewCanvas.toDataURL('image/png')
    maskEditorPreviewImageUrl.value = previewDataUri
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

    // Mask editor dialog
    maskEditorDialogVisible,
    maskEditorMode,
    showMaskEditorDialog,
    closeMaskEditorDialog,

    // Mask editor preview
    maskEditorOriginalImageUrl,
    maskEditorPreviewImageUrl,
    maskEditorIsModified,
    setMaskEditorOriginalImage,
    setMaskEditorPreview,
    clearMaskEditorPreview,
    regenerateOutpaintPreview,
  }
})

// hot reloading
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDialogStore, import.meta.hot))
}