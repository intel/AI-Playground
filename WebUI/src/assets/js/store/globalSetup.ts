import { defineStore } from "pinia";
import { util } from "../util";
import { useI18N } from "./i18n";

export const useGlobalSetup = defineStore("globalSetup", () => {
    const state = reactive<KVObject>({
        isAdminExec: false,
        device: "",
        version: "0.0.0.1"
    });

    const apiHost = ref("http://127.0.0.1:9999");

    const models = ref<ModelLists>({
        llm: new Array<string>(),
        stableDiffusion: new Array<string>(),
        inpaint: new Array<string>(),
        lora: new Array<string>(),
        vae: new Array<string>(),
        scheduler: new Array<string>(),
        embedding: new Array<string>()
    });

    const modelSettings = reactive<KVObject>({
        graphics: 0,
        resolution: 0,
        quality: 0,
        enableRag: false,
        llm_model: "microsoft/Phi-3-mini-4k-instruct",
        sd_model: "Lykon/dreamshaper-8",
        inpaint_model: "Lykon/dreamshaper-8-inpainting",
        negativePrompt: "bad hands, nsfw",
        generateNumber: 1,
        width: 512,
        height: 512,
        guidanceScale: 7.5,
        inferenceSteps: 20,
        seed: -1,
        lora: "None",
        scheduler: "None",
        embedding: "BAAI/bge-large-en-v1.5",
        imagePreview: 1,
        safeCheck: 1
    });

    const paths = ref<ModelPaths>({
        llm: "",
        embedding: "",
        stableDiffusion: "",
        inpaint: "",
        lora: "",
        vae: "",
        ESRGAN: "",
    });

    const presetModel = reactive<StringKV>({
        SDStandard: "Lykon/dreamshaper-8",
        SDStandardInpaint: "Lykon/dreamshaper-8-inpainting",
        SDHD: "RunDiffusion/Juggernaut-XL-v9",
        SDHDInpaint: useI18N().state.ENHANCE_INPAINT_USE_IMAGE_MODEL,
    });

    const graphicsList = ref(new Array<GraphicsItem>());

    let envType = "";

    async function initSetup() {
        const setupData = await window.electronAPI.getInitSetting();
        envType = setupData.envType;
        paths.value = setupData.modelPaths;
        models.value = setupData.modelLists;
        models.value.inpaint.push(useI18N().state.ENHANCE_INPAINT_USE_IMAGE_MODEL);
        state.isAdminExec = setupData.isAdminExec;
        state.version = setupData.version;
        apiHost.value = setupData.apiHost;
        loadPresetModelSettings();
        const postJson = JSON.stringify(toRaw(paths.value));
        while (true) {
            try {
                models.value.scheduler.push(...await initWebSettings(postJson));
                models.value.scheduler.unshift("None");
                break;
            } catch {
                await util.delay(500);
            }
        }
        await reloadGraphics();
        if (graphicsList.value.length == 0) {
            await window.electronAPI.showMessageBoxSync({ message: useI18N().state.ERROR_UNFOUND_GRAPHICS, title: "error", icon: "error" });
            window.electronAPI.exitApp();
            return;
        }
        await loadUserSettings();
    }

    async function reloadGraphics() {
        const formData = new FormData();
        formData.append("env", envType);
        const response = await fetch(`${apiHost.value}/api/getGraphics`, {
            body: formData,
            method: "POST"
        });
        const graphics = (await response.json()) as GraphicsItem[];
        graphicsList.value.splice(0, graphicsList.value.length, ...graphics);
    }

    async function refreshLLMModles() {
        models.value.stableDiffusion = await window.electronAPI.refreshLLMModles();
    }

    async function refreshSDModles() {
        models.value.stableDiffusion = await window.electronAPI.refreshSDModles();
    }

    async function refreshInpaintModles() {
        models.value.inpaint = await window.electronAPI.refreshInpaintModles();
    }

    async function refreshLora() {
        models.value.lora = await window.electronAPI.refreshLora();
    }

    async function initWebSettings(postJson: string) {
        const response = await fetch(`${apiHost.value}/api/init`, {
            headers: {
                "Content-Type": "application/json",
            },
            method: "post",
            body: postJson,
        });
        return await response.json() as string[];
    }

    async function applyPathsSettings(newPaths: ModelPaths) {
        models.value = await window.electronAPI.updateModelPaths(newPaths);
        const postJson = JSON.stringify(newPaths);
        await initWebSettings(postJson);
        paths.value = newPaths;
        if (models.value.inpaint) {
            models.value.inpaint = [];
        }
        models.value.inpaint.push(useI18N().state.ENHANCE_INPAINT_USE_IMAGE_MODEL);
        return assertSelectExist();
    }

    async function restorePathsSettings() {
        await window.electronAPI.restorePathsSettings();
        const setupData = await window.electronAPI.getInitSetting();
        paths.value = setupData.modelPaths;
        models.value = setupData.modelLists;
        models.value.inpaint.push(useI18N().state.ENHANCE_INPAINT_USE_IMAGE_MODEL);
        loadPresetModelSettings();
        const postJson = JSON.stringify(toRaw(paths.value));
        while (true) {
            try {
                models.value.scheduler.push(...await initWebSettings(postJson));
                models.value.scheduler.unshift("None");
                break;
            } catch {
                await util.delay(500);
            }
        }
        return assertSelectExist();
    }

    function loadPresetModelSettings() {
        const dataStr = localStorage.getItem("PresetModelSettings");
        if (dataStr) {
            const data = JSON.parse(dataStr) as StringKV;
            Object.keys(presetModel).forEach((key) => {
                if (key in data) {
                    presetModel[key] = data[key];
                }
            });
        }
    }

    function applyPresetModelSettings(presetModelSettings: StringKV) {
        Object.keys(presetModel).forEach((key) => {
            if (key in presetModelSettings) {
                presetModel[key] = presetModelSettings[key];
            }
        });
        localStorage.setItem("PresetModelSettings", JSON.stringify(toRaw(presetModel)));
    }


    function loadUserSettings() {
        const dataStr = localStorage.getItem("ModelSettings");
        if (dataStr) {
            const data = JSON.parse(dataStr) as KVObject;
            Object.keys(data).forEach((key) => {
                modelSettings[key] = data[key];
            });
        }
        assertSelectExist();

    }

    function getManualModelSettings() {
        const dataStr = localStorage.getItem("ManualModelSettings");
        if (dataStr) {
            return JSON.parse(dataStr) as KVObject;
        } else {
            return {
                llm_model: "microsoft/Phi-3-mini-4k-instruct",
                enableRag: false,
                sd_model: "Lykon/dreamshaper-8",
                negativePrompt: "bad hands, nsfw",
                generateNumber: 1,
                width: 512,
                height: 512,
                guidanceScale: 7.5,
                inferenceSteps: 40,
                seed: -1,
                lora: "None",
                scheduler: "None",
                embedding: "BAAI/bge-large-en-v1.5"
            }
        }
    }

    function assertSelectExist() {
        let changeUserSetup = false;
        if (models.value.llm.length > 0 && !models.value.llm.includes(modelSettings.llm_model)) {
            modelSettings.llm = models.value.llm[0];
            changeUserSetup = true;
        }
        if (models.value.stableDiffusion.length > 0 && !models.value.stableDiffusion.includes(modelSettings.sd_model)) {
            modelSettings.sd_model = models.value.stableDiffusion[0];
            changeUserSetup = true;
        }
        if (models.value.lora.length > 0 && !models.value.lora.includes(modelSettings.lora)) {
            modelSettings.lora = models.value.lora[0];
            changeUserSetup = true;
        }
        if (!graphicsList.value.find(item => item.index == modelSettings.graphics)) {
            modelSettings.graphics = graphicsList.value[0].index;
        }
        if (changeUserSetup) {
            localStorage.setItem("ModelSettings", JSON.stringify(toRaw(modelSettings)));
        }
        return changeUserSetup;
    }

    function applyModelSettings(newSettings: KVObject) {
        Object.keys(newSettings).forEach((key) => {
            if (key in modelSettings) {
                modelSettings[key] = newSettings[key];
            }
        });
        const rawModelSettings = toRaw(modelSettings)
        localStorage.setItem("ModelSettings", JSON.stringify(rawModelSettings));
        if (modelSettings["resolution"] == 3) {
            const manualModelSettings: StringKV = {};
            Object.keys(rawModelSettings).forEach((key) => {
                if (key != "resolution" && key != "quality") {
                    manualModelSettings[key] = rawModelSettings[key];
                }
            });
            localStorage.setItem("ManualModelSettings", JSON.stringify(manualModelSettings));
        }
    }

    async function checkModelExists(params: CheckModelExistParam[]) {
        const response = await fetch(`${apiHost.value}/api/checkModelExist`, {
            method: "POST",
            body: JSON.stringify(params),
            headers: {
                "Content-Type": "application/json"
            }
        });
        const data = (await response.json()) as ApiResponse & { exists: CheckModelExistResult[] };
        return data.exists;
    }

    return {
        state,
        modelSettings,
        presetModel,
        models,
        paths,
        apiHost,
        graphicsList,
        initSetup,
        applyPathsSettings,
        applyModelSettings,
        getManualModelSettings,
        refreshLLMModles,
        refreshSDModles,
        refreshInpaintModles,
        refreshLora,
        checkModelExists,
        applyPresetModelSettings,
        restorePathsSettings,
    };
});