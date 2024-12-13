import { defineStore } from "pinia";
import { useGlobalSetup } from "./globalSetup";

export const useBackendServices = defineStore("backendServices", () => {
    const globalSetup = useGlobalSetup();

    const info = ref<ApiServiceInformation[]>([]);
    window.electronAPI.getServices().then(services => {
        info.value = services;
    });
    window.electronAPI.onServiceInfoUpdate(updatedInfo => {
        info.value = info.value.map(oldInfo => oldInfo.serviceName === updatedInfo.serviceName ? updatedInfo : oldInfo);
    });

    const allRequiredSetUp = computed(() => info.value.length > 0 && info.value.filter(s => s.isRequired).every(s => s.isSetUp));
    const allRequiredRunning = computed(() => info.value.length > 0 && info.value.filter(s => s.isRequired).every(s => s.status === "running"));

    watch(allRequiredRunning, (newVal) => {
        if (newVal) {
            globalSetup.loadingState = "running";
        }
    });

    watch(allRequiredSetUp, (newVal) => {
        if (newVal) {
            info.value.filter(s => s.isSetUp).forEach(s => window.electronAPI.sendStartSignal(s.serviceName));
        } else if (info.value.length > 0) {
            globalSetup.loadingState = "manageInstallations";
        }
    }, {immediate: true});

    return {
        info,
        allRequiredSetUp,
        allRequiredRunning,
    }
}, {
    persist: {
        pick: [],
    }
});
