import {defineStore} from "pinia";

export const useBackendServices = defineStore("backendServices", () => {
    const currentServiceInfo = ref<ApiServiceInformation[]>([]);
    const serviceListeners: { [serviceName: string]: BackendServiceSetupProgressListener } = {
        "ai-backend": new BackendServiceSetupProgressListener("ai-backend"),
        "comfyui-backend": new BackendServiceSetupProgressListener("comfyui-backend")
    };
    window.electronAPI.getServices().then(services => {
        currentServiceInfo.value = services;
    });
    window.electronAPI.onServiceInfoUpdate(updatedInfo => {
        currentServiceInfo.value = currentServiceInfo.value.map(oldInfo => oldInfo.serviceName === updatedInfo.serviceName ? updatedInfo : oldInfo);
    });

    window.electronAPI.onServiceSetUpProgress(async (data) => {
        const associatedListener = serviceListeners[data.serviceName]
        if (!associatedListener) {
            console.warn(`received unexpected setup update for service ${data.serviceName}`)
            return
        }
        associatedListener.addData(data)
    })

    const serviceInfoUpdateReceived =  computed(() => currentServiceInfo.value.length > 0)
    const allRequiredSetUp = computed(() => currentServiceInfo.value.length > 0 && currentServiceInfo.value.filter(s => s.isRequired).every(s => s.isSetUp));
    const allRequiredRunning = computed(() => currentServiceInfo.value.length > 0 && currentServiceInfo.value.filter(s => s.isRequired).every(s => s.status === "running"));

    async function setUpService(serviceName: string): Promise<{success: boolean, logs: SetupProgress[]}> {
        const listener: BackendServiceSetupProgressListener = serviceListeners[serviceName]
        if (!listener) {
            new Error(`service name ${serviceName} not found.`)
        }
        listener.isActive = true
        window.electronAPI.sendSetUpSignal(serviceName)
        return await listener.awaitFinalizationAndResetData()
    }

    async function startService(serviceName: string): Promise<BackendStatus> {
        return window.electronAPI.sendStartSignal(serviceName)
    }

    async function stopService(serviceName: string): Promise<BackendStatus> {
        return window.electronAPI.sendStopSignal(serviceName)
    }

    return {
        info: currentServiceInfo,
        serviceInfoUpdateReceived,
        allRequiredSetUp,
        allRequiredRunning,
        setUpService,
        startService,
        stopService,
    }
}, {
    persist: {
        pick: [],
    }
});


class BackendServiceSetupProgressListener {
    isActive: Boolean = false
    readonly associatedServiceName : string
    private collectedSetupProgress: SetupProgress[] = []
    private terminalUpdateReceived = false
    private installationSuccess: boolean = false

    constructor(associatedServiceName: string) {
        this.associatedServiceName = associatedServiceName
        this.isActive = false
    }

    addData(data: SetupProgress) {
        console.log(`${data.serviceName} ${data.status} in stage ${data.step}. Debugmessage: ${data.debugMessage}`)

        if (this.isActive && data.serviceName == this.associatedServiceName) {
            this.collectedSetupProgress.push(data)
            if (data.status === "success" || data.status == "failed") {
                this.terminalUpdateReceived = true
                this.isActive = false
                this.installationSuccess = data.status === "success"
            }
        }
    }

    private async awaitFinalization(): Promise<SetupProgress[]> {
        while(!this.terminalUpdateReceived) {
            setTimeout(() => {}, 1000)
        }
        return this.collectedSetupProgress
    }

    async awaitFinalizationAndResetData(): Promise<{success: boolean, logs: SetupProgress[]}> {
        return this.awaitFinalization().then( collectedSetupProgress => {
            const clonedSetupProgress = collectedSetupProgress.slice()
            this.collectedSetupProgress = []
            return { success: this.installationSuccess, logs: clonedSetupProgress}
        })
    }
}