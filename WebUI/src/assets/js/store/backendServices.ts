import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import z from 'zod'

const backends = [
  'openvino-backend',
  'ai-backend',
  'comfyui-backend',
  'llamacpp-backend',
  'ollama-backend',
] as const

type ServiceSettings = {
  ['ai-backend']?: object
  ['comfyui-backend']?: {
    version: string
  }
  ['llamacpp-backend']?: {
    version: string
  }
  ['openvino-backend']?: {
    version: string
  }
  ['ollama-backend']?: {
    releaseTag: string
    version: string
  }
} & { serviceName: BackendServiceName }

export type BackendServiceName = (typeof backends)[number]

export const BackendVersionSchema = z.object({
  releaseTag: z.string().optional(),
  version: z.string(),
})
type BackendVersion = z.infer<typeof BackendVersionSchema>

type BackendVersionState = Record<
  BackendServiceName,
  {
    installed?: BackendVersion
    uiOverride?: BackendVersion
    target?: BackendVersion
  }
>

export const useBackendServices = defineStore(
  'backendServices',
  () => {
    const currentServiceInfo = ref<ApiServiceInformation[]>([])
    const serviceListeners = new Map(
      backends.map((b) => [b, new BackendServiceSetupProgressListener(b)]),
    )
    const lastSelectedDeviceIdPerBackend = ref<Record<BackendServiceName, string | null>>({
      'ai-backend': null,
      'comfyui-backend': null,
      'llamacpp-backend': null,
      'ollama-backend': null,
      'openvino-backend': null,
    })

    const versionState = ref<BackendVersionState>({
      'ai-backend': {},
      'comfyui-backend': {},
      'llamacpp-backend': {},
      'ollama-backend': {},
      'openvino-backend': {},
    })

    backends.forEach((serviceName) => {
      window.electronAPI.resolveBackendVersion(serviceName).then((version) => {
        versionState.value[serviceName].target = version
      })
    })
    window.electronAPI
      .getServices()
      .catch(async (_reason: unknown) => {
        console.warn('initial service call failed - retrying')
        await new Promise<void>((resolve) => {
          setTimeout(async () => {
            resolve()
          }, 1000)
        })
        return window.electronAPI.getServices()
      })
      .then((services) => {
        currentServiceInfo.value = services
      })
    setTimeout(() => {
      window.electronAPI.getServices().then((services) => {
        console.log('getServices', services)
        currentServiceInfo.value = services
      })
    }, 5000)
    window.electronAPI.onServiceInfoUpdate((updatedInfo) => {
      currentServiceInfo.value = currentServiceInfo.value.map((oldInfo) =>
        oldInfo.serviceName === updatedInfo.serviceName ? updatedInfo : oldInfo,
      )
    })

    window.electronAPI.onServiceSetUpProgress(async (data) => {
      const associatedListener = serviceListeners.get(data.serviceName)
      if (!associatedListener) {
        console.warn(`received unexpected setup update for service ${data.serviceName}`)
        return
      }
      associatedListener.addData(data)
    })

    const serviceInfoUpdatePresent = computed(() => currentServiceInfo.value.length > 0)
    const initalStartupRequestComplete = ref(false)
    const backendStartupInProgress = ref(false)
    const allRequiredSetUp = computed(
      () =>
        currentServiceInfo.value.length > 0 &&
        currentServiceInfo.value.filter((s) => s.isRequired).every((s) => s.isSetUp),
    )
    const allRequiredRunning = computed(
      () =>
        currentServiceInfo.value.length > 0 &&
        currentServiceInfo.value.filter((s) => s.isRequired).every((s) => s.status === 'running'),
    )

    async function startAllSetUpServices(): Promise<{
      allServicesStarted: boolean
    }> {
      const serverStartups = await Promise.all(
        currentServiceInfo.value
          .filter((s) => s.isSetUp)
          .map(async (s) => {
            try {
              // Try to detect devices first
              console.log(`Detecting devices for ${s.serviceName}`)
              await detectDevices(s.serviceName)
              await new Promise((resolve) => setTimeout(resolve, 100)) // wait a second for device detection to settle
              console.log(
                `Device detection complete for ${s.serviceName}`,
                JSON.stringify({
                  devices: s.devices,
                  info: currentServiceInfo.value.find((info) => info.serviceName === s.serviceName),
                }),
              )
              const lastSelectedDeviceId = lastSelectedDeviceIdPerBackend.value[s.serviceName]
              const availableDevicesIds = currentServiceInfo.value
                .find((info) => info.serviceName === s.serviceName)
                ?.devices.map((d) => d.id)
              const currentlySelectedDevice = currentServiceInfo.value
                .find((info) => info.serviceName === s.serviceName)
                ?.devices.find((d) => d.selected)?.id
              console.log(
                `Last selected device: ${lastSelectedDeviceId}, currently selected device: ${currentlySelectedDevice}, available devices: ${availableDevicesIds}`,
              )
              if (
                availableDevicesIds &&
                lastSelectedDeviceId &&
                availableDevicesIds.includes(lastSelectedDeviceId) &&
                lastSelectedDeviceId !== currentlySelectedDevice
              ) {
                console.log(`Re-selecting device ${lastSelectedDeviceId} for ${s.serviceName}`)
                await selectDevice(s.serviceName, lastSelectedDeviceId)
              }
              return await startService(s.serviceName)
            } catch (error) {
              console.error(`Service startup failed for ${s.serviceName}:`, error)
              return 'failed'
            }
          }),
      )
      const serverStartupsCompleted = {
        allServicesStarted: serverStartups.every((serverStatus) => serverStatus === 'running'),
      }
      if (!serverStartupsCompleted.allServicesStarted) {
        console.warn('Not all services started')
      }

      return serverStartupsCompleted
    }

    async function uninstallService(serviceName: BackendServiceName): Promise<void> {
      const listener = serviceListeners.get(serviceName)
      if (!listener) {
        throw new Error(`service name ${serviceName} not found.`)
      }
      listener.isActive = true
      try {
        await stopService(serviceName)
      } catch {
        console.info(`service ${serviceName} was not running`)
      }
      // Clear error details when uninstalling
      listener.clearErrorDetails()
      return window.electronAPI.uninstall(serviceName)
    }

    async function setUpService(
      serviceName: BackendServiceName,
    ): Promise<{ success: boolean; logs: SetupProgress[]; errorDetails?: ErrorDetails | null }> {
      console.log('starting setup')
      const listener = serviceListeners.get(serviceName)
      if (!listener) {
        throw new Error(`service name ${serviceName} not found.`)
      }

      listener.clearErrorDetails()
      listener.isActive = true

      try {
        await stopService(serviceName)
      } catch {
        console.warn(`service ${serviceName} was not running`)
      }

      const versions = versionState.value[serviceName]
      const targetVersionSettings = versions.uiOverride ?? versions.installed ?? versions.target
      await updateServiceSettings({ serviceName, ...targetVersionSettings })
      window.electronAPI.setUpService(serviceName)
      const result = await listener!.awaitFinalizationAndResetData()
      if (result.success) await detectDevices(serviceName)
      return result
    }

    function getServiceErrorDetails(serviceName: BackendServiceName): ErrorDetails | null {
      // First check service info (startup errors from main process)
      const serviceError = currentServiceInfo.value.find(
        (s) => s.serviceName === serviceName,
      )?.errorDetails
      if (serviceError) return serviceError

      // Then check listener (installation errors captured in renderer)
      const listener = serviceListeners.get(serviceName)
      return listener?.getLastErrorDetails() ?? null
    }

    async function updateServiceSettings(settings: ServiceSettings): Promise<BackendStatus> {
      return window.electronAPI.updateServiceSettings(settings)
    }

    async function getServiceSettings<T extends BackendServiceName>(
      serviceName: T,
    ): Promise<ServiceSettings[T]> {
      return window.electronAPI.getServiceSettings(serviceName)
    }

    function selectDevice(serviceName: BackendServiceName, deviceId: string): Promise<void> {
      lastSelectedDeviceIdPerBackend.value[serviceName] = deviceId
      return window.electronAPI.selectDevice(serviceName, deviceId)
    }

    async function detectDevices(serviceName: BackendServiceName): Promise<void> {
      return window.electronAPI.detectDevices(serviceName)
    }

    async function startService(serviceName: BackendServiceName): Promise<BackendStatus> {
      return window.electronAPI.startService(serviceName)
    }

    async function stopService(serviceName: BackendServiceName): Promise<BackendStatus> {
      return window.electronAPI.stopService(serviceName)
    }

    const lastUsedBackend = ref<BackendServiceName | null>(null)

    function updateLastUsedBackend(currentInferenceBackend: BackendServiceName) {
      lastUsedBackend.value = currentInferenceBackend
    }

    async function resetLastUsedInferenceBackend(currentInferenceBackend: BackendServiceName) {
      const lastUsedBackendSnapshot = lastUsedBackend.value
      if (lastUsedBackendSnapshot === null || lastUsedBackendSnapshot === currentInferenceBackend) {
        return
      }
      try {
        const stopStatus = await stopService(lastUsedBackendSnapshot)
        console.info(`unused service ${lastUsedBackendSnapshot} now in state ${stopStatus}`)
        const startStatus = await startService(lastUsedBackendSnapshot)
        console.info(`service ${lastUsedBackendSnapshot} now in state ${startStatus}`)
      } catch (e) {
        console.warn(
          `Could not reset last used inference backend ${lastUsedBackendSnapshot} due to ${e}`,
        )
      }
    }

    async function ensureBackendReadiness(
      serviceName: BackendServiceName,
      llmModelName: string,
      embeddingModelName?: string,
      contextSize?: number,
    ): Promise<void> {
      try {
        const result = await window.electronAPI.ensureBackendReadiness(
          serviceName,
          llmModelName,
          embeddingModelName,
          contextSize,
        )
        if (!result.success) {
          throw new Error(result.error || 'Failed to ensure backend readiness')
        }
      } catch (error) {
        console.error(`Failed to ensure backend readiness for ${serviceName}:`, error)
        throw error
      }
    }

    async function shouldShowInstallationDialog(): Promise<boolean> {
      // Wait a moment for async setup checks to complete in the main process
      // Services like ai-backend check setup asynchronously, so we need to give them time
      await new Promise((resolve) => setTimeout(resolve, 500))

      // Re-fetch service info to get the latest setup status
      try {
        const latestServices = await window.electronAPI.getServices()
        currentServiceInfo.value = latestServices
      } catch (error) {
        console.warn('Failed to refresh service info for installation check:', error)
      }

      // Only show if required backends are missing or have errors
      const requiredServices = currentServiceInfo.value.filter((s) => s.isRequired)
      return requiredServices.some(
        (s) => !s.isSetUp || (s.errorDetails !== null && s.errorDetails !== undefined),
      )
    }

    async function startAllSetUpServicesInBackground(): Promise<void> {
      if (backendStartupInProgress.value) {
        console.log('Backend startup already in progress, skipping')
        return
      }

      // Check if there are any services to start
      const servicesToStart = currentServiceInfo.value.filter((s) => s.isSetUp)
      if (servicesToStart.length === 0) {
        console.log('No services are set up to start')
        return
      }

      console.log(
        `Starting ${servicesToStart.length} backend service(s) in background:`,
        servicesToStart.map((s) => s.serviceName),
      )
      backendStartupInProgress.value = true

      // Start in background without blocking
      startAllSetUpServices()
        .then((result) => {
          console.log('Background backend startup completed', result)
          if (!result.allServicesStarted) {
            console.warn('Not all services started successfully in background')
          }
        })
        .catch((error) => {
          console.error('Background backend startup failed', error)
        })
        .finally(() => {
          backendStartupInProgress.value = false
        })
    }

    return {
      info: currentServiceInfo,
      serviceInfoUpdateReceived: serviceInfoUpdatePresent,
      allRequiredSetUp,
      allRequiredRunning,
      initalStartupRequestComplete,
      lastUsedBackend,
      versionState,
      lastSelectedDeviceIdPerBackend,
      updateLastUsedBackend,
      resetLastUsedInferenceBackend,
      startAllSetUpServices,
      setUpService,
      getServiceSettings,
      updateServiceSettings,
      startService,
      stopService,
      uninstallService,
      detectDevices,
      selectDevice,
      ensureBackendReadiness,
      getServiceErrorDetails,
      shouldShowInstallationDialog,
      startAllSetUpServicesInBackground,
      backendStartupInProgress,
    }
  },
  {
    persist: {
      pick: ['versionState', 'lastSelectedDeviceIdPerBackend'],
    },
  },
)

class BackendServiceSetupProgressListener {
  isActive: boolean = false
  readonly associatedServiceName: string
  private collectedSetupProgress: SetupProgress[] = []
  private terminalUpdateReceived = false
  private installationSuccess: boolean = false
  private lastErrorDetails: ErrorDetails | null = null

  constructor(associatedServiceName: string) {
    this.associatedServiceName = associatedServiceName
    this.isActive = false
  }

  addData(data: SetupProgress) {
    console.log(
      `${data.serviceName} ${data.status} in stage ${data.step}. Debugmessage: ${data.debugMessage}`,
    )

    if (this.isActive && data.serviceName == this.associatedServiceName) {
      this.collectedSetupProgress.push(data)

      if (data.status === 'failed' && data.errorDetails) {
        this.lastErrorDetails = data.errorDetails
      }
      if (data.status === 'success' || data.status == 'failed') {
        this.terminalUpdateReceived = true
        this.isActive = false
        this.installationSuccess = data.status === 'success'
      }
    }
  }

  private async awaitFinalization(): Promise<SetupProgress[]> {
    if (this.terminalUpdateReceived) {
      return this.collectedSetupProgress
    } else {
      return await new Promise((resolve) => {
        setTimeout(() => {
          resolve(this.awaitFinalization())
        }, 200)
      })
    }
  }

  async awaitFinalizationAndResetData(): Promise<{
    success: boolean
    logs: SetupProgress[]
    errorDetails?: ErrorDetails | null
  }> {
    return this.awaitFinalization().then((collectedSetupProgress) => {
      console.log(`server startup complete for ${this.associatedServiceName}`, {
        collectedSetupProgress,
        success: this.installationSuccess,
        errorDetails: this.lastErrorDetails,
      })
      const clonedSetupProgress = collectedSetupProgress.slice()
      const clonedErrorDetails = this.lastErrorDetails

      this.collectedSetupProgress = []
      this.terminalUpdateReceived = false
      // Don't reset lastErrorDetails here - keep them for UI access

      return {
        success: this.installationSuccess,
        logs: clonedSetupProgress,
        errorDetails: clonedErrorDetails,
      }
    })
  }

  clearErrorDetails() {
    this.lastErrorDetails = null
  }

  getLastErrorDetails(): ErrorDetails | null {
    return this.lastErrorDetails
  }
}
