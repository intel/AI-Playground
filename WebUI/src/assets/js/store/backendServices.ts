import { defineStore } from 'pinia'

const backends = ['ai-backend', 'comfyui-backend', 'llamacpp-backend', 'openvino-backend'] as const
export type BackendServiceName = (typeof backends)[number]

export const useBackendServices = defineStore(
  'backendServices',
  () => {
    const currentServiceInfo = ref<ApiServiceInformation[]>([])
    const serviceListeners = new Map(
      backends.map((b) => [b, new BackendServiceSetupProgressListener(b)]),
    )

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

    async function startAllSetUpServices(): Promise<{ allServicesStarted: boolean }> {
      const serverStartups = await Promise.all(
        currentServiceInfo.value
          .filter((s) => s.isSetUp)
          .map((s) => window.electronAPI.sendStartSignal(s.serviceName)),
      )
      const serverStartupsCompleted = {
        allServicesStarted: serverStartups.every((serverStatus) => serverStatus === 'running'),
      }
      if (!serverStartupsCompleted.allServicesStarted) {
        console.warn('Not all services started')
      }
      return serverStartupsCompleted
    }

    async function setUpService(
      serviceName: BackendServiceName,
    ): Promise<{ success: boolean; logs: SetupProgress[] }> {
      console.log('starting setup')
      const listener = serviceListeners.get(serviceName)
      if (!listener) {
        new Error(`service name ${serviceName} not found.`)
      }
      listener!.isActive = true
      window.electronAPI.sendSetUpSignal(serviceName)
      return listener!.awaitFinalizationAndResetData()
    }

    async function startService(serviceName: BackendServiceName): Promise<BackendStatus> {
      return window.electronAPI.sendStartSignal(serviceName)
    }

    async function stopService(serviceName: BackendServiceName): Promise<BackendStatus> {
      return window.electronAPI.sendStopSignal(serviceName)
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

    return {
      info: currentServiceInfo,
      serviceInfoUpdateReceived: serviceInfoUpdatePresent,
      allRequiredSetUp,
      allRequiredRunning,
      initalStartupRequestComplete,
      lastUsedBackend,
      updateLastUsedBackend,
      resetLastUsedInferenceBackend,
      startAllSetUpServices,
      setUpService,
      startService,
      stopService,
    }
  },
  {
    persist: {
      pick: [],
    },
  },
)

class BackendServiceSetupProgressListener {
  isActive: boolean = false
  readonly associatedServiceName: string
  private collectedSetupProgress: SetupProgress[] = []
  private terminalUpdateReceived = false
  private installationSuccess: boolean = false

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
        }, 1000)
      })
    }
  }

  async awaitFinalizationAndResetData(): Promise<{ success: boolean; logs: SetupProgress[] }> {
    return this.awaitFinalization().then((collectedSetupProgress) => {
      console.log(`server startup complete for ${this.associatedServiceName}`)
      const clonedSetupProgress = collectedSetupProgress.slice()
      this.collectedSetupProgress = []
      this.terminalUpdateReceived = false
      return { success: this.installationSuccess, logs: clonedSetupProgress }
    })
  }
}
