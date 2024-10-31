import { acceptHMRUpdate, defineStore } from "pinia";
import { useGlobalSetup } from "./globalSetup";
import { z } from "zod";

export const backendTypes = ['IPEX-LLM', 'LLAMA.CPP'] as const;
const backend = z.enum(backendTypes);
type Backend = z.infer<typeof backend>;

const backendModelKey = {
    'IPEX-LLM': 'llm_model',
    'LLAMA.CPP': 'ggufLLM_model',
}

export const useTextInference = defineStore("textInference", () => {

    const globalSetup = useGlobalSetup();
    const backend = ref<Backend>('IPEX-LLM');
    const activeModel = ref<string | null>(null);
    
    watch([activeModel], () => {
        console.log('activeModel changed', activeModel.value);
        globalSetup.applyModelSettings({ [backendModelKey[backend.value]]: activeModel.value });
    });

    return {
        backend,
        activeModel,
    }
}, {
    persist: {
        pick: ['backend', 'activeModel'],
    }
});

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useTextInference, import.meta.hot))
}