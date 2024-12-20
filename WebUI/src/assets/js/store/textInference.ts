import { acceptHMRUpdate, defineStore } from "pinia";
import { useGlobalSetup } from "./globalSetup";
import { z } from "zod";
import { useBackendServices } from "./backendServices";

export const backendTypes = ['IPEX-LLM', 'LLAMA.CPP'] as const;
const backend = z.enum(backendTypes);
export type Backend = z.infer<typeof backend>;

const backendModelKey = {
    'IPEX-LLM': 'llm_model',
    'LLAMA.CPP': 'ggufLLM_model',
}
export const useTextInference = defineStore("textInference", () => {

    const globalSetup = useGlobalSetup();
    const backendServices = useBackendServices();
    const backend = ref<Backend>('IPEX-LLM');
    const activeModel = ref<string | null>(null);
    const llamaBackendUrl = computed(() => {
        const url = backendServices.info.find(item => item.serviceName === "llamacpp-backend")?.baseUrl;
        console.log('url', url);
        return url;
    });

    watch([llamaBackendUrl], () => {
        console.log('llamaBackendUrl changed', llamaBackendUrl.value);
    }
    );
    
    watch([activeModel], () => {
        console.log('activeModel changed', activeModel.value);
        globalSetup.applyModelSettings({ [backendModelKey[backend.value]]: activeModel.value });
    });

    return {
        backend,
        activeModel,
        llamaBackendUrl,
    }
}, {
    persist: {
        pick: ['backend', 'activeModel'],
    }
});

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useTextInference, import.meta.hot))
}