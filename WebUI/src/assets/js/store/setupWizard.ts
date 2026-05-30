import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useBackendServices, type BackendServiceName } from './backendServices'
import { useProductMode } from './productMode'
import { useGlobalSetup } from './globalSetup'
import { usePresets } from './presets'
import { usePresetSwitching } from './presetSwitching'
import { useSpeechToText } from './speechToText'
import { useTextToSpeech } from './textToSpeech'
import { useDemoMode } from './demoMode'
import { useHomeAgent } from './homeAgent'
import { CHANNELS } from './channels/channelRegistry'
import { mapStatusToColor, mapToDisplayStatus } from '@/lib/utils'
import * as toast from '@/assets/js/toast'
import type { ErrorDetails } from '../../../../electron/subprocesses/service'

const ALL_BACKENDS: BackendServiceName[] = [
  'ai-backend',
  'home-agent-backend',
  'llamacpp-backend',
  'openvino-backend',
  'comfyui-backend',
]

function getBackends(homeAgentEnabled: boolean): BackendServiceName[] {
  return homeAgentEnabled ? ALL_BACKENDS : ALL_BACKENDS.filter((b) => b !== 'home-agent-backend')
}

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

/** Optional UI row when Phison SSD (EVFZ) is detected — maps to llamacpp-backend + SSD offload variant. */
export type PhisonAidaptivRowViewModel = {
  kind: 'phison-aidaptiv'
  displayName: string
  enabled: boolean
  toggleDisabled: boolean
  isInstalling: boolean
  statusColor: string
  statusText: string
  versionDisplay: string
  installProgressText: string | null
  toggleTooltip: string
}

const knownSteps: Record<BackendServiceName, string[]> = {
  'ai-backend': ['start', 'install dependencies'],
  'llamacpp-backend': ['start', 'download', 'extract', 'configure-service'],
  'openvino-backend': ['start', 'download', 'extract', 'install python'],
  'comfyui-backend': [
    'start',
    'install comfyUI',
    'configure comfyUI',
    'install builtin custom nodes',
    'install comfyUI manager',
  ],
  'home-agent-backend': ['start', 'install dependencies'],
}

const stepDisplayNames: Record<string, string> = {
  start: 'Preparing...',
  download: 'Downloading...',
  extract: 'Extracting...',
  'configure-service': 'Configuring SSD offload...',
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
  const textToSpeech = useTextToSpeech()
  const homeAgent = useHomeAgent()

  const pendingProductMode = ref<ProductMode | null>(null)
  const installSelection = ref(new Set<BackendServiceName>())
  const disabledBackends = ref(new Set<BackendServiceName>())
  const wizardDirty = ref(false)
  const wizardPage = ref<'main' | 'homeAgentSetup'>('main')
  const homeAgentSetupOrigin = ref<'install' | 'edit'>('install')

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

  const phisonAidaptivRow = computed<PhisonAidaptivRowViewModel | null>(() => {
    if (!backendServices.phisonSsdDetected) {
      return null
    }
    const info = backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
    const isSsdVariant = backendServices.llamaCppBuildVariant === 'ssd-offload'
    const status = info?.status ?? ('notInstalled' as BackendStatus)
    /** Active variant only — do not use for Phison row subtitle (standard toggled off still leaves Phison on disk). */
    const isSetUp = info?.isSetUp ?? false
    const phisonArtifactReady = info?.llamaCppPhisonArtifactReady ?? false
    /** Single IPC service — only the active build variant should show setup progress on this row. */
    const backendBusy =
      status === 'installing' ||
      status === 'starting' ||
      status === 'stopping' ||
      wizardActivity.value.has('llamacpp-backend')
    const phisonInstallActive = isSsdVariant && backendBusy
    const isInstalling = phisonInstallActive

    const activityMessage = wizardActivity.value.get('llamacpp-backend')
    let installProgressText: string | null = null
    if (phisonInstallActive) {
      const progress = backendServices.latestSetupProgress.get('llamacpp-backend')
      if (progress) {
        const steps = knownSteps['llamacpp-backend'] ?? []
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

    let versionDisplay = ''
    const vs = backendServices.versionState['llamacpp-backend']
    const phVer = info?.llamaCppPhisonInstalledVersion ?? (isSsdVariant ? vs.installed : undefined)
    if (phVer?.version) {
      versionDisplay = phVer.releaseTag ? `${phVer.releaseTag} / ${phVer.version}` : phVer.version
    } else if (!phisonArtifactReady) {
      versionDisplay = 'Not installed'
    } else {
      versionDisplay = mapToDisplayStatus('stopped') ?? 'Installed'
    }

    let statusColor = mapStatusToColor(status)
    let statusText = mapToDisplayStatus(status) ?? status
    if (backendBusy && !isSsdVariant) {
      statusColor = mapStatusToColor('notInstalled')
      statusText = phisonArtifactReady
        ? (mapToDisplayStatus('stopped') ?? statusText)
        : (mapToDisplayStatus('notInstalled') ?? statusText)
    } else {
      const statusIsBusy =
        status === 'failed' ||
        status === 'installationFailed' ||
        status === 'installing' ||
        status === 'starting' ||
        status === 'stopping'
      if (!statusIsBusy) {
        if (!phisonArtifactReady) {
          statusColor = mapStatusToColor('notInstalled')
          statusText = mapToDisplayStatus('notInstalled') ?? statusText
        } else if (isSsdVariant) {
          statusColor = mapStatusToColor('running')
        } else {
          statusColor = mapStatusToColor('notInstalled')
          statusText = mapToDisplayStatus('stopped') ?? statusText
        }
      }
    }

    let toggleTooltip = ''
    if (isInstalling) {
      toggleTooltip = 'Installation or startup in progress'
    } else if (isSsdVariant && isSetUp) {
      toggleTooltip =
        'Toggle off to stop using the Phison aiDAPTIV+ build (switches to standard Llama.cpp)'
    } else if (isSsdVariant && !isSetUp) {
      toggleTooltip = 'Toggle on to install the Phison aiDAPTIV+ Llama.cpp build'
    } else if (!isSsdVariant && phisonArtifactReady) {
      toggleTooltip =
        'Phison build is installed — toggle on to use aiDAPTIV+ SSD offload with Llama.cpp'
    } else if (!isSsdVariant && installSelection.value.has('llamacpp-backend')) {
      toggleTooltip = 'Turn on to switch from standard Llama.cpp GGUF to the Phison aiDAPTIV+ build'
    } else {
      toggleTooltip = 'Toggle on to enable Phison aiDAPTIV+ SSD offload for Llama.cpp'
    }

    return {
      kind: 'phison-aidaptiv',
      displayName: 'Llama.cpp-Phison aiDAPTIV+ SSD',
      enabled: isSsdVariant,
      toggleDisabled: isInstalling,
      isInstalling,
      statusColor,
      statusText,
      versionDisplay,
      installProgressText,
      toggleTooltip,
    }
  })

  const backendRows = computed<BackendRowViewModel[]>(() => {
    return getBackends(homeAgent.isFeatureEnabled).map((serviceName) => {
      const info = backendServices.info.find((s) => s.serviceName === serviceName)
      const available = isBackendAvailableInProductMode(pendingProductMode.value, serviceName)
      const isRequired = info?.isRequired ?? serviceName === 'ai-backend'
      let isSetUp = info?.isSetUp ?? false
      let status = info?.status ?? ('notInstalled' as BackendStatus)

      if (serviceName === 'comfyui-backend' && comfyUiNeedsVariantSwitch.value) {
        isSetUp = false
        status = 'notInstalled' as BackendStatus
      }

      let isInstalling =
        status === 'installing' ||
        status === 'starting' ||
        status === 'stopping' ||
        wizardActivity.value.has(serviceName)
      if (
        serviceName === 'llamacpp-backend' &&
        backendServices.llamaCppBuildVariant === 'ssd-offload'
      ) {
        isInstalling = false
      }
      let enabled = isRequired || installSelection.value.has(serviceName)
      if (serviceName === 'llamacpp-backend') {
        enabled =
          isRequired ||
          (installSelection.value.has('llamacpp-backend') &&
            backendServices.llamaCppBuildVariant === 'standard')
      }
      const phisonVariantLocksLlamaRow =
        serviceName === 'llamacpp-backend' && backendServices.llamaCppBuildVariant === 'ssd-offload'
      const toggleDisabled = isRequired || !available || isInstalling || phisonVariantLocksLlamaRow

      let toggleTooltip = ''
      if (isRequired) {
        toggleTooltip = 'Required — cannot be disabled'
      } else if (!available) {
        toggleTooltip = 'Not available in this product mode'
      } else if (isInstalling) {
        toggleTooltip = 'Installation in progress'
      } else if (phisonVariantLocksLlamaRow) {
        toggleTooltip =
          'Disabled while Phison aiDAPTIV+ SSD mode is on — use the Llama.cpp-Phison row below'
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
      } else if (
        serviceName === 'llamacpp-backend' &&
        backendServices.llamaCppBuildVariant === 'ssd-offload'
      ) {
        const rowInfo = backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
        const std = rowInfo?.llamaCppStandardInstalledVersion
        if (std?.version) {
          versionDisplay = std.releaseTag ? `${std.releaseTag} / ${std.version}` : std.version
        } else if (!rowInfo?.llamaCppStandardArtifactReady) {
          versionDisplay = 'Not installed'
        }
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
      const ggufRowShowsLlamaProgress =
        serviceName !== 'llamacpp-backend' || backendServices.llamaCppBuildVariant === 'standard'
      if (ggufRowShowsLlamaProgress && (isInstalling || activityMessage)) {
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

      let statusColor = mapStatusToColor(status)
      if (serviceName === 'llamacpp-backend') {
        const rowInfo = backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
        const standardReady = rowInfo?.llamaCppStandardArtifactReady ?? false
        const variantStandard = backendServices.llamaCppBuildVariant === 'standard'
        const transitional =
          status === 'failed' ||
          status === 'installationFailed' ||
          status === 'installing' ||
          status === 'starting' ||
          status === 'stopping'
        if (
          !variantStandard &&
          (status === 'installing' || status === 'starting' || status === 'stopping')
        ) {
          statusColor = mapStatusToColor('notInstalled')
        } else if (!transitional) {
          if (!standardReady) {
            statusColor = mapStatusToColor('notInstalled')
          } else if (variantStandard && (enabled || status === 'running')) {
            statusColor = mapStatusToColor('running')
          } else {
            statusColor = mapStatusToColor('notInstalled')
          }
        }
      }

      let rowStatusText =
        serviceName === 'comfyui-backend' && comfyUiNeedsVariantSwitch.value
          ? `Needs reinstall for ${pendingProductMode.value === 'nvidia' ? 'CUDA' : 'XPU'}`
          : (mapToDisplayStatus(status) ?? status)
      if (
        serviceName === 'llamacpp-backend' &&
        backendServices.llamaCppBuildVariant === 'ssd-offload' &&
        (status === 'installing' || status === 'starting' || status === 'stopping')
      ) {
        rowStatusText = mapToDisplayStatus('notInstalled') ?? rowStatusText
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
        statusColor,
        statusText: rowStatusText,
        versionDisplay,
        errorDetails: backendServices.getServiceErrorDetails(serviceName),
        toggleTooltip,
        installProgressText,
      }
    })
  })

  const isBusy = computed(() => backendRows.value.some((r) => r.isInstalling))

  /** Same idea as Installation Management: Llama.cpp status is often stopped/running/notYetStarted while GGUF or Phison artifacts are still missing. */
  function llamacppWizardNeedsInstall(row: BackendRowViewModel): boolean {
    if (!installSelection.value.has('llamacpp-backend')) return false
    const info = backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
    if (!info) return false
    if (row.status === 'installing' || row.status === 'starting' || row.status === 'stopping') {
      return false
    }
    if (backendServices.llamaCppBuildVariant === 'standard') {
      const standardReady = info.llamaCppStandardArtifactReady ?? false
      if (!standardReady) return true
      return row.status === 'failed' || row.status === 'installationFailed'
    }
    const phisonReady = info.llamaCppPhisonArtifactReady ?? false
    if (!phisonReady) return true
    return row.status === 'failed' || row.status === 'installationFailed'
  }

  const rowsNeedingInstall = computed(() =>
    backendRows.value.filter((r) => {
      if (!r.availableInCurrentMode) return false
      if (r.serviceName === 'llamacpp-backend') {
        return llamacppWizardNeedsInstall(r)
      }
      const needsStatus =
        r.status === 'notInstalled' || r.status === 'failed' || r.status === 'installationFailed'
      if (!needsStatus) return false
      return r.enabled
    }),
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
    for (const serviceName of getBackends(homeAgent.isFeatureEnabled)) {
      const info = backendServices.info.find((s) => s.serviceName === serviceName)
      if (!info) continue
      if (info.isRequired) continue
      if (!isBackendAvailableInProductMode(pendingProductMode.value, serviceName)) continue
      if (disabledBackends.value.has(serviceName)) continue
      if (info.isSetUp || !info.isRequired) {
        if (
          serviceName === 'llamacpp-backend' &&
          backendServices.phisonSsdDetected &&
          !info.isSetUp &&
          !(info.llamaCppPhisonArtifactReady ?? false) &&
          !(info.llamaCppStandardArtifactReady ?? false) &&
          backendServices.llamaCppBuildVariant !== 'ssd-offload'
        ) {
          continue
        }
        newSelection.add(serviceName)
      }
    }
    installSelection.value = newSelection
  }

  function isHomeAgentInstalledAndActive(): boolean {
    if (!homeAgent.isFeatureEnabled) return false
    const info = backendServices.info.find((s) => s.serviceName === 'home-agent-backend')
    return info?.isSetUp === true && !disabledBackends.value.has('home-agent-backend')
  }

  async function toggleBackend(serviceName: BackendServiceName, value: boolean) {
    const info = backendServices.info.find((s) => s.serviceName === serviceName)
    if (value) {
      if (serviceName === 'llamacpp-backend') {
        backendServices.llamaCppBuildVariant = 'standard'
      }
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
      if (serviceName === 'llamacpp-backend') {
        backendServices.llamaCppBuildVariant = 'standard'
      }
    }
    installSelection.value = new Set(installSelection.value)
  }

  async function togglePhisonAidaptiv(enabled: boolean) {
    if (enabled) {
      backendServices.llamaCppBuildVariant = 'ssd-offload'
      installSelection.value.add('llamacpp-backend')
      disabledBackends.value.delete('llamacpp-backend')
      disabledBackends.value = new Set(disabledBackends.value)
      installSelection.value = new Set(installSelection.value)
      const info = backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
      if (info?.isSetUp && (info.status === 'stopped' || info.status === 'notYetStarted')) {
        await backendServices.startService('llamacpp-backend')
      }
    } else {
      backendServices.llamaCppBuildVariant = 'standard'
    }
  }

  function setPendingMode(mode: ProductMode) {
    pendingProductMode.value = mode
    for (const sn of getBackends(homeAgent.isFeatureEnabled)) {
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
    await backendServices.refreshPhisonSsdDetection()
    pendingProductMode.value =
      productModeStore.productMode ??
      productModeStore.hardwareRecommendation?.recommendedMode ??
      null
    seedInstallSelection()
    wizardDirty.value = false
    wizardPage.value = 'main'
    globalSetup.loadingState = 'setupWizard'
  }

  async function openHomeAgentSetup() {
    if (!homeAgent.isFeatureEnabled) return
    if (!productModeStore.hardwareRecommendation) {
      await productModeStore.detectRecommendation()
    }
    pendingProductMode.value =
      productModeStore.productMode ??
      productModeStore.hardwareRecommendation?.recommendedMode ??
      null
    seedInstallSelection()
    wizardDirty.value = false
    homeAgentSetupOrigin.value = 'edit'
    wizardPage.value = 'homeAgentSetup'
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
        await backendServices.refreshPhisonSsdDetection()
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
    await backendServices.refreshPhisonSsdDetection()
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
    const toInstall = backendRows.value.filter((r) => {
      if (!r.availableInCurrentMode) return false
      if (r.serviceName === 'llamacpp-backend') {
        return llamacppWizardNeedsInstall(r)
      }
      const needsStatus =
        r.status === 'notInstalled' || r.status === 'failed' || r.status === 'installationFailed'
      if (!needsStatus) return false
      return r.enabled
    })

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

      const anyFailed = backendRows.value.some((r) => {
        if (!r.availableInCurrentMode) return false
        if (r.status !== 'failed' && r.status !== 'installationFailed') return false
        if (r.serviceName === 'llamacpp-backend') {
          return installSelection.value.has('llamacpp-backend')
        }
        return r.enabled
      })
      if (anyFailed) return
    }

    const noChannelVerified = CHANNELS.every((c) => !homeAgent.channelPrefs[c.kind].verified)
    if (homeAgent.isFeatureEnabled && noChannelVerified) {
      const homeAgentJustInstalled = toInstall.some((r) => r.serviceName === 'home-agent-backend')
      if (homeAgentJustInstalled || isHomeAgentInstalledAndActive()) {
        // Sync presets *before* swapping the wizard page so the Home Agent setup
        // step (and anything downstream of it) sees a consistent preset list
        // that reflects the just-installed backend.
        await syncPresetsForCurrentProductMode()
        homeAgentSetupOrigin.value = 'install'
        wizardPage.value = 'homeAgentSetup'
        return
      }
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
    // Clear Home Agent channel configs on reinstall so the user must re-verify
    // each channel before turning it back on. Both Telegram and Slack credentials
    // are wiped — the backend's safeStorage files and the bot/Slack-app tokens
    // injected into the running service must not survive a reinstall.
    if (name === 'home-agent-backend') {
      for (const c of CHANNELS) {
        await homeAgent.clearChannelConfig(c.kind)
      }
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

    for (const serviceName of getBackends(homeAgent.isFeatureEnabled)) {
      const info = backendServices.info.find((s) => s.serviceName === serviceName)
      if (!info?.isSetUp) continue
      if (info.isRequired || installSelection.value.has(serviceName)) {
        if (info.status !== 'running') {
          backendServices.startService(serviceName)
        }
      }
    }

    speechToText.initialize()
    textToSpeech.initialize()
  }

  /**
   * Finish the Home Agent setup step and close the wizard. Mirrors the normal
   * install path which calls `dismiss()` followed by `syncPresetsForCurrentProductMode()`,
   * so leaving the wizard via Home Agent setup also refreshes preset state.
   */
  async function finishHomeAgentSetup() {
    await dismiss()
    // Reset the wizard page after the wizard is hidden (dismiss set loadingState
    // to 'running') so HomeAgentSetupPage unmounts and its local UI state
    // (active tab, Reconfigure expansion) starts fresh on the next open. The
    // outer wizard uses v-show, so without this the page would stay mounted.
    wizardPage.value = 'main'
    await syncPresetsForCurrentProductMode()
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
    wizardPage,
    homeAgentSetupOrigin,
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
    openHomeAgentSetup,
    setPendingMode,
    seedInstallSelection,
    toggleBackend,
    togglePhisonAidaptiv,
    phisonAidaptivRow,
    commitAndInstall,
    dismiss,
    finishHomeAgentSetup,
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
      return 'AI Playground'
    case 'llamacpp-backend':
      return 'Llama.cpp - GGUF'
    case 'openvino-backend':
      return 'OpenVINO'
    case 'home-agent-backend':
      return 'Home Agent'
    default:
      return serviceName
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSetupWizard, import.meta.hot))
}
