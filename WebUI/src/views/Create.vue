<template>
    <div id="createPanel" class="h-full flex flex-col p-4">
        <div class="image-panel flex-auto flex p-4">
            <div v-if="destImg.length > 0" class="image-preview-panel flex-none">
                <div v-for="image, i in destImg" class="image-preview-item flex items-center justify-center"
                    :class="{ 'active': previewIdx == i }" @click="swithPreview(i)">
                    <div class="image-preview-item-bg">
                        <img :src="image" class="image-thumb" />
                    </div>
                </div>
            </div>
            <div class="flex-auto relative flex items-center justify-center">
                <div class="flex justify-center items-center w-768px h-512px relative bg-color-image-bg rounded-lg">
                    <img v-for="image, i in destImg" :src="image" class="max-w-768px max-h-512px"
                        v-show="previewIdx == i" />
                    <div v-show="generateIdx == previewIdx && processing"
                        class="absolute left-0 top-0 w-full h-full bg-black/50 flex justify-center items-center">
                        <loading-bar v-if="['load_model', 'load_model_components'].includes(currentState)"
                            :text="currentState == 'load_model' ? languages.COM_LOADING_MODEL : languages.COM_LOADING_MODEL_COMPONENTS"
                            class="w-3/4"></loading-bar>
                        <div v-else-if="currentState == 'generating'"
                            class="flex gap-2 items-center justify-center text-white">
                            <span class="svg-icon i-loading w-8 h-8"></span>
                            <span class="text-2xl">{{ stepText }}</span>
                        </div>
                    </div>
                    <div v-show="previewIdx != -1 && generateIdx > previewIdx"
                        class="absolute bottom-0 -right-8 box-content flex flex-col items-center justify-center gap-2">
                        <button @click="postImageToEnhance" :title="languages.COM_POST_TO_ENHANCE_PROCESS"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-transfer w-4 h-4"></span>
                        </button>
                        <button @click="showParamsDialog" :title="languages.COM_OPEN_PARAMS"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-info w-4 h-4"></span>
                        </button>
                        <button @click="openImage" :title="languages.COM_ZOOM_IN"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-zoom-in w-4 h-4"></span>
                        </button>
                        <button @click="copyImage" :title="languages.COM_COPY"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-copy w-4 h-4"></span>
                        </button>
                        <button @click="selecteImage" :title="languages.COM_OPEN_LOCATION"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-folder w-4 h-4"></span>
                        </button>
                        <!-- <button @click="regenerate" :title="languages.COM_REGENERATE"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-refresh w-4 h-4"></span>
                        </button> -->
                        <button v-show="!processing" @click="reset" :title="languages.COM_DELETE"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-delete w-4 h-4"></span>
                        </button>
                    </div>
                </div>
                <paint-info :params="infoParams" v-show="showParams" @close="showParams = false"></paint-info>
            </div>
        </div>
        <div class="h-32 gap-3 flex-none flex items-center">
            <textarea class="rounded-xl border border-color-spilter flex-auto h-full resize-none"
                :placeholder="languages.COM_SD_PROMPT" v-model="prompt" @keydown.enter.prevent="generate"></textarea>
            <button class="gernate-btn self-stretch flex flex-col w-32 flex-none" v-show="!processing"
                @click="generate">
                <span class="svg-icon i-generate-add w-7 h-7"></span>
                <span>{{ languages.COM_GENERATE }}</span>
            </button>
            <button class="gernate-btn self-stretch flex flex-col w-32 flex-none" v-show="processing"
                @click="stopGenerate">
                <span class="svg-icon w-7 h-7" :class="{ 'i-stop': !stopping, 'i-loading': stopping }"></span>
                <span>{{ languages.COM_STOP }}</span>
            </button>
        </div>
    </div>
</template>
<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n';
import { toast } from '@/assets/js/toast';
import { util } from '@/assets/js/util';
import { SSEProcessor } from "@/assets/js/sseProcessor";
import LoadingBar from "../components/LoadingBar.vue";
import PaintInfo from '@/components/PaintInfo.vue';
import { useGlobalSetup } from '@/assets/js/store/globalSetup';
import { Const } from '@/assets/js/const';

const i18nState = useI18N().state;
const globalSetup = useGlobalSetup();
const currentState = ref<SDGenerateState>("no_start");
const previewIdx = ref(0);
const generateIdx = ref(-999);
const destImg = ref<string[]>([]);
const prompt = ref("")
const processing = ref(false);
const stepText = ref("");
const downloadModel = reactive({
    downloading: false,
    text: "",
    percent: 0
});
let abortContooler: AbortController | null;
let lastPostParams: KVObject = {};
const stopping = ref(false);
const showParams = ref(false);
const generateParams = new Array<KVObject>();
const infoParams = ref<KVObject>({})

const emits = defineEmits<{
    (e: "showDownloadModelConfirm", downloadList: DownloadModelParam[], success?: () => void, fail?: () => void): void,
    (e: "postImageToEnhance", url: string): void
}>();

function finishGenerate() {
    processing.value = false;
}

function updateDestImage(index: number, image: string) {
    if (index + 1 > destImg.value.length) {
        destImg.value.push(image);
    } else {
        destImg.value.splice(index, 1, image);
    }
}

function dataProcess(line: string) {
    util.log(`SD data: ${line}`);
    const dataJson = line.slice(5);
    const data = JSON.parse(dataJson) as SDOutCallback;
    switch (data.type) {
        case "image_out":
            currentState.value = "image_out";
            updateDestImage(data.index, data.image);
            generateParams.push(data.params);
            generateIdx.value++;
            break;
        case "step_end":
            currentState.value = "generating";
            stepText.value = `${i18nState.COM_GENERATING} ${data.step}/${data.total_step}`;
            if (data.image) {
                updateDestImage(data.index, data.image);
            }
            if (data.step == 0) {
                previewIdx.value = data.index;
            }
            break;
        case "load_model":
            currentState.value = "load_model";
            break;
        case "load_model_components":
            currentState.value = data.event == "finish" ? "generating" : "load_model_components";
            break;
        case "error":
            processing.value = false;
            currentState.value = "error";
            switch (data.err_type) {
                case "not_enough_disk_space":
                    toast.error(i18nState.ERR_NOT_ENOUGH_DISK_SPACE.replace("{requires_space}", data.requires_space).replace("{free_space}", data.free_space));
                    break;
                case "download_exception":
                    toast.error(i18nState.ERR_DOWNLOAD_FAILED);
                    break;
                case "runtime_error":
                    toast.error(i18nState.ERROR_RUNTIME_ERROR);
                    break;
                case "unknow_exception":
                    toast.error(i18nState.ERROR_GENERATE_UNKONW_EXCEPTION);
                    break;
            }
            break;
    }
}

async function generate() {
    if (processing.value) { return; }
    try {
        processing.value = true;
        await checkModel();
        lastPostParams = {
            mode: 0,
            device: globalSetup.modelSettings.graphics,
            prompt: prompt.value,
            model_repo_id: `stableDiffusion:${globalSetup.modelSettings.sd_model}`,
            negative_prompt: globalSetup.modelSettings.negativePrompt,
            generate_number: globalSetup.modelSettings.generateNumber,
            inference_steps: globalSetup.modelSettings.inferenceSteps,
            guidance_scale: globalSetup.modelSettings.guidanceScale,
            seed: globalSetup.modelSettings.seed,
            height: globalSetup.modelSettings.height,
            width: globalSetup.modelSettings.width,
            lora: globalSetup.modelSettings.lora,
            scheduler: globalSetup.modelSettings.scheduler,
            image_preview: globalSetup.modelSettings.imagePreview,
            safe_check : globalSetup.modelSettings.safeCheck
        };

        await sendGenerate();
    } catch (ex) {
    } finally {
        processing.value = false;
    }
}

async function checkModel() {
    return new Promise<void>(async (resolve, reject) => {
        const checkList: CheckModelExistParam[] = [{ repo_id: globalSetup.modelSettings.sd_model, type: Const.MODEL_TYPE_STABLE_DIFFUSION }];
        if (globalSetup.modelSettings.lora != "None") {
            checkList.push({ repo_id: globalSetup.modelSettings.lora, type: Const.MODEL_TYPE_LORA })
        }
        if (globalSetup.modelSettings.imagePreview) {
            checkList.push({ repo_id: "madebyollin/taesd", type: Const.MODEL_TYPE_PREVIEW })
            checkList.push({ repo_id: "madebyollin/taesdxl", type: Const.MODEL_TYPE_PREVIEW })
        }
        const result = await globalSetup.checkModelExists(checkList);
        const downloadList: CheckModelExistParam[] = [];
        for (const item of result) {
            if (!item.exist) {
                downloadList.push({ repo_id: item.repo_id, type: item.type })
            }
        }
        if (downloadList.length > 0) {
            emits(
                "showDownloadModelConfirm",
                downloadList,
                resolve,
                reject
            );
        } else {
            resolve && resolve();
        }
    });
}

async function sendGenerate() {
    try {
        reset();
        processing.value = true;
        if (!abortContooler) {
            abortContooler = new AbortController()
        }
        generateIdx.value = 0;
        previewIdx.value = 0;
        stepText.value = i18nState.COM_GENERATING;
        const response = await fetch(`${useGlobalSetup().apiHost}/api/sd/generate`, {
            method: "POST",
            body: util.convertToFromData(lastPostParams),
            signal: abortContooler.signal
        })
        const reader = response.body!.getReader();
        await new SSEProcessor(reader, dataProcess, finishGenerate).start();
    } finally {
        processing.value = false;
    }
}

async function stopGenerate() {
    if (processing.value && !stopping.value) {
        stopping.value = true;
        await fetch(`${globalSetup.apiHost}/api/sd/stopGenerate`);
        if (abortContooler) {
            abortContooler.abort();
            abortContooler = null;
        }
        processing.value = false;
        stopping.value = false;
    }
}

function postImageToEnhance() {
    emits("postImageToEnhance", destImg.value[previewIdx.value]);
}

function openImage() {
    const path = destImg.value[previewIdx.value];
    window.electronAPI.openImageWithSystem(path);

}

function selecteImage() {
    window.electronAPI.selecteImage(destImg.value[previewIdx.value]);
}


function copyImage() {
    util.copyImage(destImg.value[previewIdx.value]);
    toast.success(i18nState.COM_COPY_SUCCESS_TIP);
}

function reset() {
    currentState.value = "no_start";
    generateParams.splice(0, generateParams.length);
    destImg.value.splice(0, destImg.value.length);
    generateIdx.value = -999;
    previewIdx.value = -1;
    downloadModel.downloading = false;
}

function swithPreview(i: number) {
    previewIdx.value = i;
    if (i > -1) {
        infoParams.value = generateParams[i];
    } else {
        showParams.value = false;
    }
}

function showParamsDialog() {
    showParams.value = true;
    infoParams.value = generateParams[previewIdx.value];
}
</script>