<template>
    <div class="flex flex-col h-full p-4">
        <div class="image-panel flex-auto flex pb-4 h-0">
            <div class="image-preview-panel flex-none overflow-y-auto">
                <div v-if="sourceImg" class="image-preview-item flex items-center justify-center flex-none"
                    :class="{ 'active': previewIdx == -1 }" @click="swithPreview(-1)">
                    <div class="image-preview-item-bg">
                        <img :src="sourceImg" class="image-thumb" />
                    </div>
                    <span class="preview-tip">{{ languages.ENHANCE_PREVIEW_BEFORE_PROCESS }}</span>
                </div>
                <div v-for="image, i in destImg" class="image-preview-item flex items-center justify-center flex-none"
                    :class="{ 'active': previewIdx == i }" @click="swithPreview(previewIdx = i)">
                    <div class="image-preview-item-bg">
                        <img :src="image" class="image-thumb" />
                    </div>
                    <span class="preview-tip">{{ languages.ENHANCE_PREVIEW_AFTER_PROCESS }}</span>
                </div>
            </div>
            <div class="flex-auto relative flex items-center justify-center">
                <div class="flex justify-center items-center bg-color-image-bg rounded-lg relative"
                    style="width: 768px; height: 400px;">
                    <!--inpaint mask-->
                    <div class="relative">
                        <img v-show="previewIdx == -1" :src="sourceImg" class="max-w-768px max-h-400px"
                            @load="updateMaskData" ref="sourceImage" />
                        <inpaint-mask ref="inpaintMaskCompt"
                            v-show="mode == 3 && previewIdx == -1 && generateState != 'no_start'"
                            :brush-size="maskBrush.size" :easer-size="maskEaser.size" :width="maskData.width"
                            :height="maskData.height" :mode="maskData.mode"></inpaint-mask>
                    </div>
                    <div class="absolute -right-8 bottom-3 flex flex-col items-center justify-center gap-2  text-white">
                        <!--inpaint mask pen-->
                        <button id="mask-pen" v-show="mode == 3 && previewIdx == -1 && generateState != 'no_start'"
                            @click="switchMaskDrawMode(0)"
                            class="bg-color-image-tool-button w-6 h-6 rounded-sm flex justify-center items-center">
                            <span class="svg-icon  i-pen w-5 h-5"></span>
                        </button>
                        <div v-show="mode == 3 && previewIdx == -1 && generateState != 'no_start' && maskData.mode == 0"
                            class="flex flex-col items-center justify-center gap-2 absolute h-44 border rounded border-color-control-bg w-5 py-1 "
                            :style="{ 'left': maskBrush.x, 'top': maskBrush.y }">
                            <div class="flex flex-col items-center justify-center gap-1 flex-auto">
                                <span class="w-3 h-3 bg-gray-400 rounded-full flex-none"></span>
                                <vertical-slide-bar type="vertical" :showEditbox="false"
                                    v-model:current="maskBrush.size" :min="1" :max="64" :step="1" class="flex-auto">
                                </vertical-slide-bar>
                                <span class="w-2 h-2 bg-gray-400 rounded-full flex-none"></span>
                            </div>
                            <span class="w-4 h-4 rounded flex justify-center items-center">
                                <span class="svg-icon i-pen w-3 h-3 "></span>
                            </span>
                        </div>
                        <!--inpaint mask easer-->
                        <button id="mask-easer" v-show="mode == 3 && previewIdx == -1 && generateState != 'no_start'"
                            @click="switchMaskDrawMode(1)"
                            class="bg-color-image-tool-button w-6 h-6 rounded-sm flex justify-center items-center">
                            <span class="svg-icon i-easer w-5 h-5"></span>
                        </button>
                        <div v-show="mode == 3 && generateState != 'no_start' && previewIdx == -1 && maskData.mode == 1"
                            class="flex flex-col items-center justify-center gap-2 absolute h-44 border rounded border-color-control-bg w-5 py-1 "
                            :style="{ 'left': maskEaser.x, 'top': maskEaser.y }">
                            <div class="flex flex-col items-center justify-center gap-1 flex-auto">
                                <span class="w-3 h-3 bg-gray-400 rounded-full flex-none"></span>
                                <vertical-slide-bar type="vertical" :showEditbox="false"
                                    v-model:current="maskEaser.size" :min="1" :max="64" :step="1" class="flex-auto">
                                </vertical-slide-bar>
                                <span class="w-2 h-2 bg-gray-400 rounded-full flex-none"></span>
                            </div>
                            <span class="w-4 h-4 rounded flex justify-center items-center">
                                <span class="svg-icon i-easer w-3 h-3 "></span>
                            </span>
                        </div>
                        <!--inpaint mask clear-->
                        <button v-show="mode == 3 && generateState != 'no_start' && previewIdx == -1"
                            @click="inpaintMaskCompt?.clearMaskImage"
                            class="bg-color-image-tool-button w-6 h-6 rounded-sm flex justify-center items-center">
                            <span class="svg-icon i-broom w-5 h-5"></span>
                        </button>
                        <button v-show="previewIdx != -1 && previewIdx <= generateFinishIdx" @click="postImageToEnhance"
                            :title="languages.COM_POST_TO_ENHANCE_PROCESS"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-transfer w-4 h-4"></span>
                        </button>
                        <button v-show="previewIdx != -1 && previewIdx <= generateFinishIdx" @click="toggleParamsDialog"
                            :title="languages.COM_OPEN_PARAMS"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-info w-4 h-4"></span>
                        </button>
                        <button v-show="previewIdx != -1 && previewIdx <= generateFinishIdx" @click="openImage"
                            :title="languages.COM_ZOOM_IN"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-zoom-in w-4 h-4"></span>
                        </button>
                        <button v-show="previewIdx != -1 && previewIdx <= generateFinishIdx" @click="copyImage"
                            :title="languages.COM_COPY"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-copy w-4 h-4"></span>
                        </button>
                        <button v-show="previewIdx != -1 && previewIdx <= generateFinishIdx" @click="selecteImage"
                            :title="languages.COM_OPEN_LOCATION"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-folder w-4 h-4"></span>
                        </button>
                        <button v-show="sourceImg && !processing"
                            class="bg-color-image-tool-button w-6 h-6 rounded-sm flex justify-center items-center">
                            <span class="svg-icon i-delete w-5 h-5" @click="removeImage"></span>
                        </button>
                    </div>
                    <img v-for=" image, i in destImg " :src="image" v-show="previewIdx == i"
                        class="max-w-768px max-h-400px" />
                    <div v-show="processing && generateIdx == previewIdx"
                        class="absolute left-0 top-0 w-full h-full bg-black/50 flex justify-center items-center">
                        <loading-bar v-if="['load_model', 'load_model_components'].includes(generateState)"
                            :text="generateState == 'load_model' ? languages.COM_LOADING_MODEL : languages.COM_LOADING_MODEL_COMPONENTS"
                            class="w-3/4"></loading-bar>
                        <div v-else-if="generateState == 'generating'"
                            class="flex gap-2 items-center justify-center text-white">
                            <span class="svg-icon i-loading w-8 h-8"></span>
                            <span class="text-2xl">{{ stepText }}</span>
                        </div>
                    </div>
                </div>
                <paint-info :params="infoParams" v-show="showParams" @close="showParams = false"></paint-info>
            </div>
        </div>
        <div class="flex flex-col gap-2 flex-none">
            <div class="flex justify-center items-center gap-3">
                <textarea class="flex-auto h-20 resize-none" :placeholder="languages.COM_SD_PROMPT" v-model="prompt"
                    :disabled="disabledPrompt" @keypress.enter.prevent="generate"></textarea>
                <button class="gernate-btn self-stretch  flex flex-col w-32 flex-none" v-show="!processing"
                    @click="generate">
                    <span class="svg-icon i-generate-add w-6 h-6"></span>
                    <span>{{ languages.COM_GENERATE }}</span>
                </button>
                <button class="gernate-btn self-stretch flex flex-col w-32 flex-none" v-show="processing"
                    @click="stopGenerate">
                    <span class="svg-icon w-7 h-7" :class="{ 'i-stop': !stopping, 'i-loading': stopping }"></span>
                    <span>{{ languages.COM_STOP }}</span>
                </button>
            </div>
        </div>
        <div class="flex flex-col flex-none h-44">
            <div class="enhance-tabs flex-none pt-2 flex items-end justify-start gap-1 text-gray-400">
                <button class="tab" :class="{ 'active': mode == 1 }" @click="switchFeature(1)"
                    :title="languages.ENHANCE_UPSCALE_TIP">
                    <span>{{
                        languages.ENHANCE_UPSCALE
                    }}</span></button>
                <button class="tab" :class="{ 'active': mode == 2 }" @click="switchFeature(2)"
                    :title="languages.ENHANCE_IMAGE_PROMPT_TIP"><span>{{
                        languages.ENHANCE_IMAGE_PROMPT
                        }}</span></button>
                <button class="tab" :class="{ 'active': mode == 3 }" @click="switchFeature(3)"
                    :title="languages.ENHANCE_INPAINT_TIP"><span>{{
                        languages.ENHANCE_INPAINT
                        }}</span></button>
                <button class="tab" :class="{ 'active': mode == 4 }" @click="switchFeature(4)"
                    :title="languages.ENHANCE_OUTPAINT_TIP"><span>{{
                        languages.ENHANCE_OUTPAINT
                        }}</span></button>
            </div>
            <div class="enhance-content flex-auto border p-2 rounded-b-md border-color-spilter">
                <div class="w-80 rounded-lg bg-color-control-bg relative h-full">
                    <div class="flex flex-col items-center justify-center gap-2 text-white text-xs h-full">
                        <p class="text-sm">{{ languages.COM_CLICK_UPLOAD }}</p>
                    </div>
                    <input ref="uploadFile" type="file"
                        class="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer"
                        accept="image/gif,image/jpeg,image/jpg,image/png" :title="languages.COM_UPLOAD_TIP_4"
                        @change="chooseImage" @drop="dropImageFile">
                </div>
                <upscale-options v-if="mode == 1" ref="upscaleCompt" @disable-prompt="disablePrompt"></upscale-options>
                <image-prompt-options v-else-if="mode == 2" ref="imagePromptCompt"
                    @disable-prompt="disablePrompt"></image-prompt-options>
                <inpaint-options v-else-if="mode == 3" ref="inpaintCompt"></inpaint-options>
                <outpaint-options v-else-if="mode == 4" ref="outpaintCompt"
                    @disable-prompt="disablePrompt"></outpaint-options>
            </div>
        </div>
    </div>
</template>
<script setup lang="ts">
import { useI18N } from "@/assets/js/store/i18n";
import UpscaleOptions from "../components/UpscaleOptions.vue";
import OutpaintOptions from "../components/OutpaintOptions.vue";
import InpaintOptions from "../components/InpaintOptions.vue";
import ImagePromptOptions from "../components/ImagePromptOptions.vue";
import { util } from "@/assets/js/util";
import { toast } from "@/assets/js/toast";
import { SSEProcessor } from "@/assets/js/sseProcessor";
import LoadingBar from "../components/LoadingBar.vue";
import VerticalSlideBar from "@/components/VerticalSlideBar.vue";
import PaintInfo from "@/components/PaintInfo.vue";
import { useGlobalSetup } from "@/assets/js/store/globalSetup";
import InpaintMask from "../components/InpaintMask.vue";
import { Const } from "@/assets/js/const";
const i18nState = useI18N().state;
const globalSetup = useGlobalSetup();
const mode = ref(1);
const sourceImage = ref<HTMLImageElement>();
const sourceImg = ref<string>("");
let sourceImgFile: File | null;
const destImg = ref<string[]>([]);
const previewIdx = ref(-1);
const generateIdx = ref(-999);
const generateFinishIdx = ref(-999);
const generateState = ref<SDGenerateState>("no_start");
const processing = ref(false);
const upscaleCompt = ref<InstanceType<typeof UpscaleOptions>>();
const imagePromptCompt = ref<InstanceType<typeof ImagePromptOptions>>();
const inpaintCompt = ref<InstanceType<typeof InpaintOptions>>();
const outpaintCompt = ref<InstanceType<typeof OutpaintOptions>>();
const prompt = ref("");
const stepText = ref("");
const inpaintMaskCompt = ref<InstanceType<typeof InpaintMask>>();
const maskData = reactive({
    width: 200,
    height: 200,
    mode: 0,
});
const uploadFile = ref<HTMLInputElement>();

const disabledPrompt = ref(false);
const maskBrush = reactive({
    size: 32,
    x: "0px",
    y: "0px",
});
const maskEaser = reactive({
    size: 32,
    x: "0px",
    y: "0px",
});
let lastPostParams: KVObject = {};
const emits = defineEmits<{
    (e: "showDownloadModelConfirm", downloadList: DownloadModelParam[], success?: () => void, fail?: () => void): void,
}>();
let abortContooler: AbortController | null;
const stopping = ref(false);
const showParams = ref(false);
const generateParams = new Array<KVObject>();
const infoParams = ref<KVObject>({})

watchEffect(() => {
    if (mode.value == 3 && previewIdx.value == -1) {
        nextTick(() => {
            switchMaskDrawMode(maskData.mode);
        });
    }
})

function updateMaskData(e: Event) {
    const image = e.target as HTMLImageElement
    maskData.width = image.clientWidth;
    maskData.height = image.clientHeight;
    inpaintMaskCompt.value!.clearMaskImage();
}

function previewImage(image: File) {
    const reader = new FileReader();
    reader.addEventListener("load", function () {
        image.arrayBuffer().then(bufer => {
            const imgUrl = URL.createObjectURL(new Blob([bufer]));
            sourceImg.value = imgUrl;
            destImg.value.splice(0, destImg.value.length);
            previewIdx.value = -1;
            generateState.value = "input_image";
            if (mode.value == 3 && previewIdx.value == -1) {
                nextTick(() => {
                    switchMaskDrawMode(maskData.mode);
                });
            }
        })
    });
    reader.readAsArrayBuffer(image);

}

function chooseImage(e: Event) {
    const file = (e.target as HTMLInputElement).files![0];
    if (!/^image\/(gif|jpeg|jpg|png)$/i.test(file.type)) {
        toast.error(i18nState.ERROR_UNSUPPORTED_IMAGE_TYPE);
        return;
    }
    sourceImgFile = file;
    if (sourceImg.value != null) {
        if (sourceImg.value.startsWith(location.host)) {
            URL.revokeObjectURL(sourceImg.value);
        }
        previewImage(file)
    }
}

function dropImageFile(e: DragEvent) {
    if (e.dataTransfer && e.dataTransfer.files) {
        const file = e.dataTransfer.files.item(0)!;
        previewImage(file);
    }
}

function switchFeature(value: number) {
    mode.value = value;
}

function finishGenerate() {
    processing.value = false;
}

function updateDestImage(index: number, image: string) {
    if (index + 1 > destImg.value.length) {
        destImg.value.push(image);
    } else {
        destImg.value.splice(index, 1, image);
    }
    previewIdx.value = index;
}

function dataProcess(line: string) {
    util.log(`SD data: ${line}`);
    const dataJson = line.slice(5);
    const data = JSON.parse(dataJson) as SDOutCallback;
    switch (data.type) {
        case "image_out":
            generateState.value = "image_out";
            updateDestImage(data.index, data.image);
            generateParams.push(data.params);
            generateIdx.value++;
            generateFinishIdx.value++;
            break;
        case "step_end":
            generateState.value = "generating";
            stepText.value = `${i18nState.COM_GENERATING} ${data.step}/${data.total_step}`;
            if (data.image) {
                updateDestImage(data.index, data.image);
            }
            if (data.step == 0) {
                previewIdx.value = data.index;
            }
            break;
        case "load_model":
            generateState.value = "load_model";
            break;
        case "load_model_components":
            generateState.value = data.event == "finish" ? "generating" : "load_model_components";
            break;
        case "error":
            processing.value = false;
            generateState.value = "error";
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

function getParams(): KVObject {
    switch (mode.value) {
        case 1:
            return upscaleCompt.value!.getParams();
        case 2:
            return imagePromptCompt.value!.getParams();
        case 3:
            return Object.assign({
                mask_image: inpaintMaskCompt.value!.getMaskImage(),
                mask_width: maskData.width,
                mask_height: maskData.height
            }, inpaintCompt.value!.getParams());
        case 4:
            return outpaintCompt.value!.getParams();
        default:
            throw Error("unkonw mode");
    }
}


async function generate() {
    if (sourceImgFile == null) {
        toast.error(i18nState.ENHANCE_INPUT_IMAGE_REQUIRED);
        return;
    }
    if (processing.value) { return; }
    await checkModel();
    try {
        processing.value = true;
        const extParams = getParams();
        const model_repo_id =
            [3, 4].includes(mode.value) && globalSetup.modelSettings.inpaint_model != i18nState.ENHANCE_INPAINT_USE_IMAGE_MODEL
                ? `inpaint:${globalSetup.modelSettings.inpaint_model}`
                : `stableDiffusion:${globalSetup.modelSettings.sd_model}`;
        lastPostParams = Object.assign({
            mode: mode.value,
            device: globalSetup.modelSettings.graphics,
            prompt: prompt.value,
            model_repo_id: model_repo_id,
            negative_prompt: globalSetup.modelSettings.negativePrompt,
            image: sourceImgFile,
            generate_number: globalSetup.modelSettings.generateNumber,
            inference_steps: globalSetup.modelSettings.inferenceSteps,
            guidance_scale: globalSetup.modelSettings.guidanceScale,
            seed: globalSetup.modelSettings.seed,
            height: globalSetup.modelSettings.height,
            width: globalSetup.modelSettings.width,
            lora: globalSetup.modelSettings.lora,
            scheduler: globalSetup.modelSettings.scheduler,
            image_preview: globalSetup.modelSettings.imagePreview,
            safe_check: globalSetup.modelSettings.safeCheck
        }, extParams);

        await sendGenerate();
    } catch (ex: any) {
        toast.error(ex.toString());
    } finally {
        processing.value = false;
    }
}


async function checkModel() {
    return new Promise<void>(async (resolve, reject) => {
        const checkList: CheckModelExistParam[] = [];
        if ([3, 4].includes(mode.value) && globalSetup.modelSettings.inpaint_model != i18nState.ENHANCE_INPAINT_USE_IMAGE_MODEL) {
            checkList.push({ repo_id: globalSetup.modelSettings.inpaint_model, type: Const.MODEL_TYPE_INPAINT });
        } else {
            checkList.push({ repo_id: globalSetup.modelSettings.sd_model, type: Const.MODEL_TYPE_STABLE_DIFFUSION });
        }
        if ([1, 3, 4].includes(mode.value)) {
            checkList.push({ repo_id: "RealESRGAN_x2plus", type: Const.MODEL_TYPE_ESRGAN })
        }
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
        generateState.value = "generating";
        previewIdx.value = 0;
        generateIdx.value = 0;
        generateFinishIdx.value = -1;
        stepText.value = i18nState.COM_GENERATING;
        processing.value = true;
        destImg.value.splice(0, destImg.value.length);
        if (!abortContooler) {
            abortContooler = new AbortController();
        }
        const response = await fetch(`${globalSetup.apiHost}/api/sd/generate`, {
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


function postImageToEnhance() {
    receiveImage(destImg.value[previewIdx.value]);
}

function openImage() {
    const index = previewIdx.value
    if (index == -1) {
        window.electronAPI.openImageWithSystem(sourceImg.value);
    } else {
        window.electronAPI.openImageWithSystem(destImg.value[index]);
    }
}

function copyImage() {
    util.copyImage(destImg.value[previewIdx.value]);
}

async function selecteImage() {
    const url = destImg.value[previewIdx.value];
    window.electronAPI.selecteImage(url);
}

function removeImage() {
    generateState.value = "no_start";
    sourceImg.value = "";
    sourceImgFile = null;
    previewIdx.value = -1;
    generateIdx.value = -999;
    generateFinishIdx.value = -1;
    stepText.value = "";
    generateParams.splice(0, generateParams.length);
    destImg.value.splice(0, destImg.value.length);
    inpaintMaskCompt.value?.clearMaskImage();
    uploadFile.value!.value = "";
}

async function receiveImage(url: string) {
    const response = await fetch(url);
    sourceImgFile = new File([await response.blob()], "temp.png");
    if (sourceImg.value != null) {
        if (sourceImg.value.startsWith(location.host)) {
            URL.revokeObjectURL(sourceImg.value);
        }
        previewImage(sourceImgFile)
    }
}

function disablePrompt(enable: boolean) {
    disabledPrompt.value = enable;
}

function switchMaskDrawMode(mode: number) {
    maskData.mode = mode;
    if (mode == 0) {
        const target = document.getElementById("mask-pen");
        if (!target) {
            return;
        }
        // const offseSet = util.getDomOffset(target);
        maskBrush.x = `${target.offsetLeft + target.offsetWidth + 16}px`;
        maskBrush.y = `${target.offsetTop + (target.clientHeight / 2) - 80}px`;
    } else {
        const target = document.getElementById("mask-easer");
        if (!target) {
            return;
        }
        // const offseSet = util.getDomOffset(target);
        maskEaser.x = `${target.offsetLeft + target.offsetWidth + 16}px`;
        maskEaser.y = `${target.offsetTop + (target.clientHeight / 2) - 80}px`;
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
function swithPreview(i: number) {
    previewIdx.value = i;
    if (i > -1) {
        infoParams.value = generateParams[i];
    } else {
        showParams.value = false;
    }
}

function toggleParamsDialog() {
    if (showParams.value) {
        showParams.value = false;
    } else {
        showParams.value = true;
        infoParams.value = generateParams[previewIdx.value];
    }
}
defineExpose({ receiveImage })
</script>