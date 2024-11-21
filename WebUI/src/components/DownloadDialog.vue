<template>
    <div class="dialog-container z-10">
        <div class="dialog-mask absolute left-0 top-0 w-full h-full bg-black/55 flex justify-center items-center">
            <div class="py-20 px-20 w-768px flex flex-col items-center justify-center bg-gray-600 rounded-3xl gap-8 text-white"
                :class="{ 'animate-scale-in': animate }">
                <div v-if="showComfirm" class="text-center flex items-center flex-col gap-5">
                    <p>{{ i18nState.DOWNLOADER_CONFRIM_TIP }}</p>
                    <table class="text-left w-full">
                        <thead>
                            <tr class=" text-gray-300 font-bold">
                                <td>{{ languages.DOWNLOADER_MODEL }}</td>
                                <td>{{ languages.DOWNLOADER_FILE_SIZE }}</td>
                                <td>{{ languages.DOWNLOADER_GATED }}</td>
                                <td>{{ languages.DOWNLOADER_INFO }}</td>
                                <td>{{ languages.DOWNLOADER_REASON }}</td>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="item in downloadList" class="">
                                <td>{{ item.repo_id }}</td>
                                <td>
                                    <span v-if="sizeRequesting" class="svg-icon i-loading w-4 h-4"></span>
                                    <span v-else>{{ item.size }}</span>
                                </td>
                                <td>
                                    <span v-if="sizeRequesting" class="svg-icon i-loading w-4 h-4"></span>
                                    <svg v-if="item.gated" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1" stroke="currentColor" class="size-6 ml-2">
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                                    </svg>
                                    <svg v-else xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1" stroke="currentColor" class="size-6 ml-2">
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                                    </svg>
                                </td>
                                <td>
                                    <a :href="getInfoUrl(item.repo_id, item.type)" target="_blank"
                                        class="text-blue-500 text-sm">
                                        {{ i18nState.DOWNLOADER_TERMS }}
                                    </a>
                                </td>
                                <td class="text-sm text-green-400">
                                    {{ getFunctionTip(item.type) }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <div v-if="downloadList.some((i) => i.gated && !i.accessGranted) && downloadList.length === 1" class="flex flex-col items-center gap-2 p-4 border border-red-600 bg-red-600/10 rounded-lg">
                        <span class="font-bold mx-4">{{ languages.DOWNLOADER_ACCESS_INFO_SINGLE }}</span>
                        <span class="text-left">
                          {{ !models.hfTokenIsValid ? languages.DOWNLOADER_GATED_TOKEN : ""}}
                          {{ downloadList.some((i) => i.gated) ? languages.DOWNLOADER_GATED_ACCEPT_SINGLE : ""}}
                          {{ downloadList.some((i) => !i.accessGranted) ? languages.DOWNLOADER_ACCESS_ACCEPT_SINGLE : ""}}
                        </span>
                    </div>
                    <div v-if="downloadList.some((i) => i.gated && !i.accessGranted) && downloadList.length > 1" class="flex flex-col items-center gap-2 p-4 border border-red-600 bg-red-600/10 rounded-lg">
                      <span class="font-bold mx-4">{{ languages.DOWNLOADER_ACCESS_INFO }}</span>
                      <span class="text-left">
                        {{ !models.hfTokenIsValid ? languages.DOWNLOADER_GATED_TOKEN : ""}}
                        {{ downloadList.some((i) => i.gated) ? languages.DOWNLOADER_GATED_ACCEPT : ""}}
                        {{ downloadList.some((i) => !i.accessGranted) ? languages.DOWNLOADER_ACCESS_ACCEPT : ""}}
                      </span>
                    </div>
                    <div class="flex items-center gap-2">
                        <button class="v-checkbox-control flex-none w-5 h-5"
                            :class="{ 'v-checkbox-checked': readTerms }" @click="readTerms = !readTerms">
                        </button>
                        <span class="text-sm text-left">{{ languages.DOWNLOADER_TERMS_TIP }}</span>
                    </div>
                    <div class="flex justify-center items-center gap-9">
                        <button @click="cancelConfirm" class="bg-color-control-bg  py-1 px-4 rounded">{{
                            i18nState.COM_CANCEL
                        }}</button>
                        <button @click="confirmDownload" :disabled="sizeRequesting || !readTerms || downloadList.every((i) => !i.accessGranted)"
                            class="bg-color-active py-1 px-4 rounded">{{
                                i18nState.COM_CONFIRM
                            }}</button>
                    </div>
                </div>
                <div v-else="hashError" class="flex flex-col items-center justify-center gap-4">
                    <p>{{ errorText }}</p>
                    <button @click="close" class="bg-red-500 py-1 px-4">{{ i18nState.COM_CLOSE }}</button>
                </div>
                <template v-else>
                    <progress-bar :text="allDownloadTip" :percent="taskPercent" class="w-3/4"></progress-bar>
                    <progress-bar :text="curDownloadTip" :percent="percent" class="w-3/4"></progress-bar>
                    <button @click="cancelDownload" class="bg-red-500 py-1 px-4">{{ i18nState.COM_CANCEL }}</button>
                </template>
            </div>
        </div>
    </div>
</template>
<script setup lang="ts">
import { useGlobalSetup } from '@/assets/js/store/globalSetup';
import ProgressBar from './ProgressBar.vue';
import { useI18N } from '@/assets/js/store/i18n';
import { SSEProcessor } from '@/assets/js/sseProcessor';
import { util } from '@/assets/js/util';
import { Const } from '@/assets/js/const';
import { toast } from '@/assets/js/toast';
import { useModels } from '@/assets/js/store/models';

const i18nState = useI18N().state;
const globalSetup = useGlobalSetup();
const models = useModels();
let downloding = false;
const curDownloadTip = ref("");
const allDownloadTip = ref("");
const percent = ref(0);
const completeCount = ref(0);
const taskPercent = ref(0);
const showComfirm = ref(false);
const sizeRequesting = ref(false);
const hashError = ref(false);
const errorText = ref("");
let abortController: AbortController;
const animate = ref(false);
const emits = defineEmits<{
    (e: "close"): void
}>();
const readTerms = ref(false);
const downloadList = ref<DownloadModelRender[]>([]);


function dataProcess(line: string) {
    console.log(line);
    const dataJson = line.slice(5);
    const data = JSON.parse(dataJson) as LLMOutCallback;
    switch (data.type) {
        case "download_model_progress":
            curDownloadTip.value = `${i18nState.COM_DOWNLOAD_MODEL} ${data.repo_id}\r\n${data.download_size}/${data.total_size} ${data.percent}% ${i18nState.COM_DOWNLOAD_SPEED}: ${data.speed}`;
            percent.value = data.percent;
            break;
        case "download_model_completed":
            completeCount.value++;
            const allTaskCount = downloadList.value.length;
            if (completeCount.value == allTaskCount) {
                downloding = false;
                emits("close");
                downloadResolve && downloadResolve();
            } else {
                taskPercent.value = util.toFixed(completeCount.value / allTaskCount * 100, 1);
                percent.value = 100;
                allDownloadTip.value = `${i18nState.DOWNLOADER_DONWLOAD_TASK_PROGRESS} ${completeCount.value}/${allTaskCount}`;
            }
            models.refreshModels();
            break;
        case "allComplete":
            downloding = false;
            emits("close");
            break;
        case "error":
            hashError.value = true;
            switch (data.err_type) {
                case "not_enough_disk_space":
                    errorText.value = i18nState.ERR_NOT_ENOUGH_DISK_SPACE.replace("{requires_space}", data.requires_space).replace("{free_space}", data.free_space);
                    break;
                case "download_exception":
                    errorText.value = i18nState.ERR_DOWNLOAD_FAILED;
                    toast.error(i18nState.ERR_DOWNLOAD_FAILED);
                    break;
                case "runtime_error":
                    errorText.value = i18nState.ERROR_RUNTIME_ERROR;
                    break;
                case "unknow_exception":
                    errorText.value = i18nState.ERROR_GENERATE_UNKONW_EXCEPTION;
                    break;
            }
            break;
    }
}

let downloadResolve: undefined | (() => void);
let downloadReject: ((args: DownloadFailedParams) => void) | undefined

async function showConfirm(downList: DownloadModelParam[], success?: () => void, fail?: (args: DownloadFailedParams) => void) {
    if (downloding) {
        toast.error(i18nState.DOWNLOADER_CONFLICT);
        fail && fail({ type: "conflict" })
        return;
    }
    animate.value = true;
    curDownloadTip.value = i18nState.DOWNLOADER_CONFRIM_TIP;
    showComfirm.value = true;
    hashError.value = false;
    percent.value = 0;
    downloadList.value = downList.map((item) => {
        return { repo_id: item.repo_id, type: item.type, size: "???", backend: item.backend }
    });
    readTerms.value = false;
    downloadResolve = success;
    downloadReject = fail;
    try {
        const sizeResponse = await fetch(`${globalSetup.apiHost}/api/getModelSize`, {
            method: "POST",
            body: JSON.stringify(downList),
            headers: {
                "Content-Type": "application/json"
            }
        });
        const gatedResponse = await fetch(`${globalSetup.apiHost}/api/isModelGated`, {
            method: "POST",
            body: JSON.stringify(downList),
            headers: {
                "Content-Type": "application/json"
            }
        });
        const accessResponse = await fetch(`${globalSetup.apiHost}/api/isAccessGranted`, {
          method: "POST",
          body: JSON.stringify([downList,models.hfToken]),
          headers: {
            "Content-Type": "application/json"
          }
        });
        const sizeData = (await sizeResponse.json()) as ApiResponse & { sizeList: StringKV };
        const gatedData = (await gatedResponse.json()) as ApiResponse & { gatedList: Record<string, boolean> };
        const accessData = (await accessResponse.json()) as ApiResponse & { accessList: Record<string, boolean> };
        for (const item of downloadList.value) {
            item.size = sizeData.sizeList[`${item.repo_id}_${item.type}`] || "";
            item.gated = gatedData.gatedList[item.repo_id] || false;
            item.accessGranted = accessData.accessList[item.repo_id] || false;
        }
        downloadList.value = downloadList.value;
        sizeRequesting.value = false;
    } catch (ex) {
        fail && fail({ type: "error", error: ex });
    }
}

function getInfoUrl(repoId: string, type: number) {
    if (type == 4){
        return "https://github.com/xinntao/Real-ESRGAN" 
    }
    
    switch(repoId){
        case "Lykon/dreamshaper-8":
            return "https://huggingface.co/spaces/CompVis/stable-diffusion-license"
        case "Lykon/dreamshaper-8-inpainting":
            return "https://huggingface.co/spaces/CompVis/stable-diffusion-license"
        case "RunDiffusion/Juggernaut-XL-v9":
            return "https://huggingface.co/spaces/CompVis/stable-diffusion-license"
        case "microsoft/Phi-3-mini-4k-instruct":
            return "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct/resolve/main/LICENSE"
        case "BAAI/bge-large-en-v1.5":
            return "https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/mit.md"
        case "latent-consistency/lcm-lora-sdv1-5":
            return "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md"
        case "latent-consistency/lcm-lora-sdxl":
            return "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md"

    }
    
    return `https://huggingface.co/${repoId}`;
}

function getFunctionTip(type: number) {
    switch (type) {
        case Const.MODEL_TYPE_LLM:
            return i18nState.DOWNLOADER_FOR_ANSWER_GENERATE;
        case Const.MODEL_TYPE_EMBEDDING:
            return i18nState.DOWNLOADER_FOR_RAG_QUERY;
        case Const.MODEL_TYPE_STABLE_DIFFUSION:
        case Const.MODEL_TYPE_LORA:
        case Const.MODEL_TYPE_VAE:
            return i18nState.DOWNLOADER_FOR_IMAGE_GENERATE;
        case Const.MODEL_TYPE_INPAINT:
            return i18nState.DOWNLOADER_FOR_INAPINT_GENERATE;
        case Const.MODEL_TYPE_PREVIEW:
            return i18nState.DOWNLOADER_FOR_IMAGE_PREVIEW;
        case Const.MODEL_TYPE_ESRGAN:
            return i18nState.DOWNLOADER_FOR_IMAGE_UPSCALE;
    }
}

function download() {
    downloding = true;
    allDownloadTip.value = `${i18nState.DOWNLOADER_DONWLOAD_TASK_PROGRESS} 0/${downloadList.value.filter(item => item.accessGranted === true).length}`;
    percent.value = 0;
    completeCount.value = 0;
    abortController = new AbortController();
    curDownloadTip.value = "";
    fetch(`${globalSetup.apiHost}/api/downloadModel`, {
        method: "POST",
        body: JSON.stringify(toRaw({ 'data': downloadList.value})),
        headers: {
            "Content-Type": "application/json",
            ...(models.hfTokenIsValid ? { Authorization: `Bearer ${models.hfToken}` } : {})
        },
        signal: abortController.signal
    }).then((response) => {
        const reader = response.body!.getReader();
        return new SSEProcessor(reader, dataProcess, undefined).start();
    }).catch(ex => {
        downloadReject && downloadReject({ type: "error", error: ex });
        downloding = false;
    })
}

function cancelConfirm() {
    downloadReject && downloadReject({ type: "cancelConfrim" });
    emits("close");
}

function confirmDownload() {
    showComfirm.value = false;
    hashError.value = false;
    return download();
}

function cancelDownload() {
    abortController?.abort();
    fetch(`${globalSetup.apiHost}/api/stopDownloadModel`)
    emits("close");
    downloadReject && downloadReject({ type: "cancelDownload" });
}

function close() {
    downloadReject && downloadReject({ type: "error", error: errorText.value });
}


defineExpose({ showConfirm, download });
</script>
<style scoped>
table {
    border-collapse: separate;
    border-spacing: 10px;
}
</style>