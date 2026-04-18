import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useBackendServices, type BackendServiceName } from './backendServices'
import { useProductMode } from './productMode'
import { useGlobalSetup } from './globalSetup'
import { usePresets } from './presets'
import { usePresetSwitching } from './presetSwitching'
import { useSpeechToText } from './speechToText'
import { useDemoMode } from './demoMode'
import { mapStatusToColor, mapToDisplayStatus } from '@/lib/utils'
import * as toast from '@/assets/js/toast'
import type { ErrorDetails } from '../../../../electron/subprocesses/service'

const backends: BackendServiceName[] = [
  'ai-backend',
  'llamacpp-backend',
  'openvino-backend',
  'comfyui-backend',
]

function isBackendAvailableInProductMode(
  mode: ProductMode | null,
  serviceName: BackendServiceName,
): boolean {
  if (mode === 'nvidia' && serviceName === 'openvino-backend') return false
  return true
}

export type BackendRowViewModel = {
  serviceName: BackendServiceName
  displayName: string
  isRequired: boolean
  isSetUp: boolean
  status: BackendStatus
  enabled: boolean
  availableInCurrentMode: boolean
  toggleDisabled: boolean
  isInstalling: boolean
  statusColor: string
  statusText: string
  versionDisplay: string
  errorDetails: ErrorDetails | null
  toggleTooltip: string
  installProgressText: string | null
}

const knownSteps: Record<BackendServiceName, string[]> = {
  'ai-backend': ['start', 'install dependencies'],
  'llamacpp-backend': ['start', 'download', 'extract'],
  'openvino-backend': ['start', 'download', 'extract', 'install python'],
  'comfyui-backend': [
    'start',
    'install comfyUI',
    'configure comfyUI',
    'install builtin custom nodes',
    'install comfyUI manager',
  ],
}

const stepDisplayNames: Record<string, string> = {
  start: 'Preparing...',
  download: 'Downloading...',
  extract: 'Extracting...',
  'install dependencies': 'Installing dependencies...',
  'install python': 'Installing Python environment...',
  'install comfyUI': 'Installing ComfyUI...',
  'configure comfyUI': 'Configuring...',
  'install builtin custom nodes': 'Installing custom nodes...',
  'install comfyUI manager': 'Installing ComfyUI Manager...',
}

export const useSetupWizard = defineStore('setupWizard', () => {
  const backendServices = useBackendServices()
  const productModeStore = useProductMode()
  const globalSetup = useGlobalSetup()
  const presetsStore = usePresets()
  const presetSwitching = usePresetSwitching()
  const demoMode = useDemoMode()
  const speechToText = useSpeechToText()

  const pendingProductMode = ref<ProductMode | null>(null)
  const installSelection = ref(new Set<BackendServiceName>())
  const disabledBackends = ref(new Set<BackendServiceName>())
  const wizardDirty = ref(false)

  const wizardActivity = ref(new Map<BackendServiceName, string>())

  const errorModalOpen = ref(false)
  const errorModalServiceName = ref<BackendServiceName | null>(null)
  const errorModalDetails = ref<ErrorDetails | null>(null)

  const comfyUiNeedsVariantSwitch = computed(() => {
    const current = productModeStore.productMode
    const pending = pendingProductMode.value
    if (!current || !pending || current === pending) return false
    const crossesNvidiaBoundary = current === 'nvidia' || pending === 'nvidia'
    if (!crossesNvidiaBoundary) return false
    const comfyInfo = backendServices.info.find((s) => s.serviceName === 'comfyui-backend')
    return comfyInfo?.isSetUp === true
  })

  const backendRows = computed<BackendRowViewModel[]>(() => {
    return backends.map((serviceName) => {
      const info = backendServices.info.find((s) => s.serviceName === serviceName)
      const available = isBackendAvailableInProductMode(pendingProductMode.value, serviceName)
      const isRequired = info?.isRequired ?? serviceName === 'ai-backend'
      let isSetUp = info?.isSetUp ?? false
      let status = info?.status ?? ('notInstalled' as BackendStatus)

      if (serviceName === 'comfyui-backend' && comfyUiNeedsVariantSwitch.value) {
        isSetUp = false
        status = 'notInstalled' as BackendStatus
      }

      const isInstalling =
        status === 'installing' ||
        status === 'starting' ||
        status === 'stopping' ||
        wizardActivity.value.has(serviceName)
      const enabled = isRequired || installSelection.value.has(serviceName)
      const toggleDisabled = isRequired || !available || isInstalling

      let toggleTooltip = ''
      if (isRequired) {
        toggleTooltip = 'Required — cannot be disabled'
      } else if (!available) {
        toggleTooltip = 'Not available in this product mode'
      } else if (isInstalling) {
        toggleTooltip = 'Installation in progress'
      } else if (isSetUp && enabled) {
        toggleTooltip = 'Toggle off to stop this component'
      } else if (isSetUp && !enabled) {
        toggleTooltip = 'Toggle on to start this component'
      } else if (!isSetUp && enabled) {
        toggleTooltip = 'Toggle off to skip installation'
      } else {
        toggleTooltip = 'Toggle on to install this component'
      }

      let versionDisplay = ''
      if (serviceName === 'ai-backend') {
        versionDisplay = globalSetup.state.version ?? ''
      } else {
        const vs = backendServices.versionState[serviceName]
        if (vs.installed?.version) {
          versionDisplay = vs.installed.releaseTag
            ? `${vs.installed.releaseTag} / ${vs.installed.version}`
            : vs.installed.version
        } else if (
          !isSetUp &&
          !(serviceName === 'comfyui-backend' && comfyUiNeedsVariantSwitch.value)
        ) {
          versionDisplay = 'Not installed'
        }
      }

      const activityMessage = wizardActivity.value.get(serviceName)
      let installProgressText: string | null = null
      if (isInstalling || activityMessage) {
        const progress = backendServices.latestSetupProgress.get(serviceName)
        if (progress) {
          const steps = knownSteps[serviceName] ?? []
          const stepIdx = steps.indexOf(progress.step)
          const label = stepDisplayNames[progress.step] ?? progress.debugMessage
          installProgressText = stepIdx >= 0 ? `${label} (${stepIdx + 1}/${steps.length})` : label
        } else if (activityMessage) {
          installProgressText = activityMessage
        } else if (status === 'stopping') {
          installProgressText = 'Stopping...'
        } else if (status === 'starting') {
          installProgressText = 'Starting...'
        } else {
          installProgressText = 'Preparing...'
        }
      }

      return {
        serviceName,
        displayName: mapServiceNameToDisplayName(serviceName),
        isRequired,
        isSetUp,
        status,
        enabled,
        availableInCurrentMode: available,
        toggleDisabled,
        isInstalling,
        statusColor: mapStatusToColor(status),
        statusText:
          serviceName === 'comfyui-backend' && comfyUiNeedsVariantSwitch.value
            ? `Needs reinstall for ${pendingProductMode.value === 'nvidia' ? 'CUDA' : 'XPU'}`
            : (mapToDisplayStatus(status) ?? status),
        versionDisplay,
        errorDetails: backendServices.getServiceErrorDetails(serviceName),
        toggleTooltip,
        installProgressText,
      }
    })
  })

  const isBusy = computed(() => backendRows.value.some((r) => r.isInstalling))

  const rowsNeedingInstall = computed(() =>
    backendRows.value.filter(
      (r) =>
        r.enabled &&
        r.availableInCurrentMode &&
        (r.status === 'notInstalled' || r.status === 'failed' || r.status === 'installationFailed'),
    ),
  )

  const primaryLabel = computed(() => {
    if (isBusy.value) return 'Installing...'
    if (rowsNeedingInstall.value.length > 0) return 'Install & Continue'
    return 'Continue'
  })

  const canClose = computed(() => {
    return backendRows.value
      .filter((r) => r.availableInCurrentMode)
      .every((r) => r.status === 'running' || !r.isRequired)
  })

  const canRunPrimary = computed(() => {
    if (isBusy.value) return false
    if (!pendingProductMode.value) return false
    return true
  })

  function seedInstallSelection() {
    const newSelection = new Set<BackendServiceName>()
    for (const serviceName of backends) {
      const info = backendServices.info.find((s) => s.serviceName === serviceName)
      if (!info) continue
      if (info.isRequired) continue
      if (!isBackendAvailableInProductMode(pendingProductMode.value, serviceName)) continue
      if (disabledBackends.value.has(serviceName)) continue
      if (info.isSetUp || !info.isRequired) {
        newSelection.add(serviceName)
      }
    }
    installSelection.value = newSelection
  }

  async function toggleBackend(serviceName: BackendServiceName, value: boolean) {
    const info = backendServices.info.find((s) => s.serviceName === serviceName)
    if (value) {
      installSelection.value.add(serviceName)
      disabledBackends.value.delete(serviceName)
      disabledBackends.value = new Set(disabledBackends.value)
      if (info?.isSetUp && (info.status === 'stopped' || info.status === 'notYetStarted')) {
        await backendServices.startService(serviceName)
      }
    } else {
      installSelection.value.delete(serviceName)
      disabledBackends.value.add(serviceName)
      disabledBackends.value = new Set(disabledBackends.value)
      if (info?.status === 'running') {
        await backendServices.stopService(serviceName)
      }
    }
    installSelection.value = new Set(installSelection.value)
  }

  function setPendingMode(mode: ProductMode) {
    pendingProductMode.value = mode
    for (const sn of backends) {
      const wasAvailable = isBackendAvailableInProductMode(
        productModeStore.productMode ?? pendingProductMode.value,
        sn,
      )
      const nowAvailable = isBackendAvailableInProductMode(mode, sn)
      if (nowAvailable && !wasAvailable) {
        const info = backendServices.info.find((s) => s.serviceName === sn)
        if (info && !info.isSetUp && !info.isRequired) {
          installSelection.value.add(sn)
        }
      }
    }
    installSelection.value = new Set(installSelection.value)
  }

  async function openWizard() {
    if (!productModeStore.hardwareRecommendation) {
      await productModeStore.detectRecommendation()
    }
    pendingProductMode.value =
      productModeStore.productMode ??
      productModeStore.hardwareRecommendation?.recommendedMode ??
      null
    seedInstallSelection()
    wizardDirty.value = false
    globalSetup.loadingState = 'setupWizard'
  }

  let initialLoadingPollHandle: ReturnType<typeof setTimeout> | null = null

  async function initialize() {
    if (!backendServices.serviceInfoUpdateReceived) {
      globalSetup.loadingState = 'verifyBackend'
      if (initialLoadingPollHandle !== null) {
        clearTimeout(initialLoadingPollHandle)
      }
      initialLoadingPollHandle = setTimeout(() => {
        initialLoadingPollHandle = null
        void initialize()
      }, 1000)
      return
    }

    if (initialLoadingPollHandle !== null) {
      clearTimeout(initialLoadingPollHandle)
      initialLoadingPollHandle = null
    }

    await globalSetup.initSetup()
    const modeStatus = await productModeStore.ensureReady()

    if (modeStatus === 'ready') {
      const allRequiredSetUp = backendServices.info
        .filter((s) => s.isRequired)
        .every((s) => s.isSetUp)

      const anyFailed = backendServices.info.some(
        (s) => s.status === 'failed' || s.status === 'installationFailed',
      )

      if (allRequiredSetUp && !anyFailed) {
        pendingProductMode.value = productModeStore.productMode
        seedInstallSelection()
        await dismiss()
        return
      }
    }

    if (!productModeStore.hardwareRecommendation) {
      await productModeStore.detectRecommendation()
    }

    pendingProductMode.value =
      productModeStore.productMode ??
      productModeStore.hardwareRecommendation?.recommendedMode ??
      null
    seedInstallSelection()
    wizardDirty.value = false
    globalSetup.loadingState = 'setupWizard'
  }

  async function syncPresetsForCurrentProductMode() {
    await productModeStore.syncToMain()
    await presetsStore.reloadAfterProductModeChange()
    await presetSwitching.reconcileActivePresetAfterCatalogReload()
    if (demoMode.enabled) {
      await demoMode.refreshFromMainConfig()
    }
  }

  async function commitAndInstall() {
    if (!pendingProductMode.value) return

    // Capture what needs installing BEFORE syncing mode — syncing resets the
    // variant-switch detection because current and pending modes become equal.
    const toInstall = backendRows.value.filter(
      (r) =>
        r.enabled &&
        r.availableInCurrentMode &&
        (r.status === 'notInstalled' || r.status === 'failed' || r.status === 'installationFailed'),
    )

    if (pendingProductMode.value !== productModeStore.productMode) {
      await productModeStore.selectMode(pendingProductMode.value)
    }

    if (toInstall.length > 0) {
      wizardDirty.value = true

      for (const row of toInstall) {
        if (row.status === 'failed' || row.status === 'installationFailed') {
          await repairBackend(row.serviceName)
        } else {
          await installBackend(row.serviceName)
        }
      }

      const anyFailed = backendRows.value.some(
        (r) =>
          r.enabled &&
          r.availableInCurrentMode &&
          (r.status === 'failed' || r.status === 'installationFailed'),
      )
      if (anyFailed) return
    }

    await dismiss()
    await syncPresetsForCurrentProductMode()
  }

  async function installBackend(name: BackendServiceName) {
    wizardDirty.value = true
    const result = await backendServices.setUpService(name)
    if (result.success) {
      await restartBackend(name)
    } else {
      const msg = result.errorDetails ? 'Setup failed — see error log for details' : 'Setup failed'
      toast.error(msg)
    }
  }

  async function repairBackend(name: BackendServiceName) {
    const stopStatus = await backendServices.stopService(name)
    if (stopStatus !== 'stopped') {
      toast.error('Service failed to stop')
      return
    }
    await installBackend(name)
  }

  async function restartBackend(name: BackendServiceName) {
    const stopStatus = await backendServices.stopService(name)
    if (stopStatus !== 'stopped') {
      toast.error('Service failed to stop')
      return
    }

    try {
      wizardActivity.value.set(name, 'Detecting devices...')
      wizardActivity.value = new Map(wizardActivity.value)
      await backendServices.detectDevices(name)

      wizardActivity.value.set(name, 'Starting...')
      wizardActivity.value = new Map(wizardActivity.value)
      const startStatus = await backendServices.startService(name)
      if (startStatus !== 'running') {
        const errorDetails = backendServices.getServiceErrorDetails(name)
        const msg = errorDetails
          ? 'Service failed to start — see error log for details'
          : 'Service failed to start'
        toast.error(msg)
      }
    } catch (error) {
      const errorDetails = backendServices.getServiceErrorDetails(name)
      const msg = errorDetails
        ? 'Service startup failed — see error log for details'
        : `Service startup failed: ${error instanceof Error ? error.message : String(error)}`
      toast.error(msg)
    } finally {
      wizardActivity.value.delete(name)
      wizardActivity.value = new Map(wizardActivity.value)
    }
  }

  async function dismiss() {
    await globalSetup.initSetup()
    globalSetup.loadingState = 'running'

    for (const serviceName of backends) {
      const info = backendServices.info.find((s) => s.serviceName === serviceName)
      if (!info?.isSetUp) continue
      if (info.isRequired || installSelection.value.has(serviceName)) {
        if (info.status !== 'running') {
          backendServices.startService(serviceName)
        }
      }
    }

    speechToText.initialize()
  }

  function showErrorModal(serviceName: BackendServiceName) {
    errorModalServiceName.value = serviceName
    errorModalDetails.value = backendServices.getServiceErrorDetails(serviceName)
    errorModalOpen.value = true
  }

  function closeErrorModal() {
    errorModalOpen.value = false
    errorModalServiceName.value = null
    errorModalDetails.value = null
  }

  return {
    pendingProductMode,
    installSelection,
    wizardDirty,
    backendRows,
    isBusy,
    rowsNeedingInstall,
    primaryLabel,
    canClose,
    canRunPrimary,

    errorModalOpen,
    errorModalServiceName,
    errorModalDetails,

    initialize,
    openWizard,
    setPendingMode,
    seedInstallSelection,
    toggleBackend,
    commitAndInstall,
    dismiss,
    installBackend,
    repairBackend,
    restartBackend,
    showErrorModal,
    closeErrorModal,
  }
})

function mapServiceNameToDisplayName(serviceName: string) {
  switch (serviceName) {
    case 'comfyui-backend':
      return 'ComfyUI'
    case 'ai-backend':
      return 'Gungwang AI Playground'
    case 'llamacpp-backend':
      return 'Llama.cpp - GGUF'
    case 'openvino-backend':
      return 'OpenVINO'
    default:
      return serviceName
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSetupWizard, import.meta.hot))
}
