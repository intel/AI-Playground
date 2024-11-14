<template>
    <div class="dialog-container z-10">
        <div class="dialog-mask absolute left-0 top-0 w-full h-full bg-black/55 flex justify-center items-center">
            <div class="py-20 px-20 w-768px flex flex-col items-center justify-center bg-gray-600 rounded-3xl gap-8 text-white"
                :class="{ 'animate-scale-in': animate }">
              <p>{{ i18nState.REQUEST_LLM_MODEL_NAME }}</p>
              <textarea class="rounded-xl border border-color-spilter flex-auto w-full h-auto resize-none"
                        :placeholder="languages.COM_LLM_HF_PROMPT" v-model="modelRequest" @keydown="fastGenerate"></textarea>
              <div class="flex justify-center items-center gap-9">
                <button @click="cancelDownload" class="rounded border bg-red-500 py-1 px-4">{{ i18nState.COM_CANCEL }}</button>
                <button @click="addModel" class="rounded border bg-red-500 py-1 px-4">{{ i18nState.COM_ADD }}</button>
              </div>
            </div>
        </div>
    </div>
</template>
<script setup lang="ts">
import { useGlobalSetup } from '@/assets/js/store/globalSetup';
import ProgressBar from './ProgressBar.vue';
import Answer from '@/views/Answer.vue';
import { useI18N } from '@/assets/js/store/i18n';
import { SSEProcessor } from '@/assets/js/sseProcessor';
import { util } from '@/assets/js/util';
import { Const } from '@/assets/js/const';
import { toast } from '@/assets/js/toast';
import { useModels } from '@/assets/js/store/models';
import DownloadDialog from "@/components/DownloadDialog.vue";

const i18nState = useI18N().state;
const globalSetup = useGlobalSetup();
const models = useModels();
let downloding = false;
const curDownloadTip = ref("");
const allDownloadTip = ref("");
const modelRequest = ref("");
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
    (e: "close"): void, (e: "addModel"): void
}>();
const readTerms = ref(false);
const downloadList = ref<DownloadModelRender[]>([]);
const componentAnswer = ref<InstanceType<typeof Answer>>();


onDeactivated(() => {
    animate.value = false;
})

function fastGenerate(e: KeyboardEvent) {
  // ToDo: Live-Check if model available
  if (e.code == "Enter") {
    if (e.ctrlKey || e.shiftKey || e.altKey) {
      modelRequest.value += "\n";
    } else {
      e.preventDefault();
      addModel()
    }
  }
}

function addModel() {
  // Check if model exists - if not --> error message
  // Check if model is not already in list
  // go to download dialog
  globalSetup.modelSettings.llm_model =  modelRequest.value
  // ToDo: try to connect to checkModel in a better way
  emits("addModel");
  // componentAnswer.value!.checkModel()
  // ToDo: close panel when download dialog works
}


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

async function showLLMRequest(success?: () => void, fail?: (args: DownloadFailedParams) => void) {
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
        return { repo_id: item.repo_id, type: item.type, size: "???" }
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
        const sizeData = (await sizeResponse.json()) as ApiResponse & { sizeList: StringKV };
        const gatedData = (await gatedResponse.json()) as ApiResponse & { gatedList: Record<string, boolean> };
        for (const item of downloadList.value) {
            item.size = sizeData.sizeList[`${item.repo_id}_${item.type}`] || "";
            item.gated = gatedData.gatedList[item.repo_id] || false;
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
    allDownloadTip.value = `${i18nState.DOWNLOADER_DONWLOAD_TASK_PROGRESS} 0/${downloadList.value.length}`;
    percent.value = 0;
    completeCount.value = 0;
    abortController = new AbortController();
    curDownloadTip.value = "";
    fetch(`${globalSetup.apiHost}/api/downloadModel`, {
        method: "POST",
        body: JSON.stringify(toRaw(downloadList.value)),
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


defineExpose({ showLLMRequest, download });
</script>
<style scoped>
table {
    border-collapse: separate;
    border-spacing: 10px;
}
</style>