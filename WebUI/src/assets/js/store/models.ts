import { defineStore } from "pinia";

export type ModelType = "llm" | "embedding" | "stableDiffusion" | "inpaint" | "lora" | "vae" | "undefined";

export type Model = {
    name: string;
    downloaded: boolean;
    type: ModelType;
}

const predefinedModels: Model[] = [
    { name: 'Qwen/Qwen2-1.5B-Instruct', type: 'llm', downloaded: false },
    { name: 'microsoft/Phi-3-mini-4k-instruct', type: 'llm', downloaded: false },
    // { name: 'meta-llama/Meta-Llama-3.1-8B-Instruct', type: 'llm', downloaded: false },
    { name: 'mistralai/Mistral-7B-Instruct-v0.3', type: 'llm', downloaded: false },
    // { name: 'google/gemma-7b', type: 'llm', downloaded: false },
    // { name: 'THUDM/chatglm3-6b', type: 'llm', downloaded: false },
]    

export const userModels: Model[] = [
]

export const useModels = defineStore("models", () => {

    const hfToken = ref<string | undefined>(undefined);
    const models = ref(predefinedModels);
    const llms = computed(() => models.value.filter(m => m.type === 'llm'));

    const downloadList = ref<DownloadModelParam[]>([]);

    async function refreshModels() {
        const sdModels = await window.electronAPI.getDownloadedDiffusionModels();
        const llmModels = await window.electronAPI.getDownloadedLLMs();
        const loraModels = await window.electronAPI.getDownloadedLoras();
        const inpaintModels = await window.electronAPI.getDownloadedInpaintModels();
        const embeddingModels = await window.electronAPI.getDownloadedEmbeddingModels();
        
        const downloadedModels = [
            ...sdModels.map<Model>(name => ({ name, type: 'stableDiffusion', downloaded: true })),
            ...llmModels.map<Model>(name => ({ name, type: 'llm', downloaded: true })),
            ...loraModels.map<Model>(name => ({ name, type: 'lora', downloaded: true })),
            ...inpaintModels.map<Model>(name => ({ name, type: 'inpaint', downloaded: true })),
            ...embeddingModels.map<Model>(name => ({ name, type: 'embedding', downloaded: true })),
        ];

        const notYetDownloaded = (model: Model) => !downloadedModels.map(m => m.name).includes(model.name);

        models.value = [...downloadedModels, ...userModels.filter(notYetDownloaded), ...predefinedModels.filter(notYetDownloaded)];

        }

    async function download(models: DownloadModelParam[]) {
    };
    refreshModels()

    return {
        models,
        llms,
        hfToken,
        hfTokenIsValid: computed(() => hfToken.value?.startsWith('hf_')),
        downloadList,
        refreshModels,
        download,
    }
}, {
    persist: {
        pick: ['hfToken'],
    }
});
