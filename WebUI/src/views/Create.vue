<template>
    <div id="createPanel" class="h-full flex flex-col p-4">
        <div class="image-panel flex-auto flex p-4">
            <div v-if="imageGeneration.imageUrls.length > 0" class="image-preview-panel flex-none">
                <div v-for="image, i in imageGeneration.imageUrls" class="image-preview-item flex items-center justify-center"
                    :class="{ 'active': imageGeneration.previewIdx == i }" @click="swithPreview(i)">
                    <div class="image-preview-item-bg">
                        <img :src="image" class="image-thumb" />
                    </div>
                </div>
            </div>
            <div class="flex-auto relative flex items-center justify-center">
                <div
                    class="flex justify-center items-center w-768px h-512px relative bg-color-image-bg rounded-lg border border-white/30">
                    <img v-for="image, i in imageGeneration.imageUrls" :src="image" class="p-1 max-w-768px max-h-512px"
                        v-show="imageGeneration.previewIdx == i" />
                    <div v-show="imageGeneration.generateIdx == imageGeneration.previewIdx && imageGeneration.processing"
                        class="absolute left-0 top-0 w-full h-full bg-black/50 flex justify-center items-center">
                        <loading-bar v-if="['load_model', 'load_model_components'].includes(imageGeneration.currentState)"
                            :text="imageGeneration.currentState == 'load_model' ? languages.COM_LOADING_MODEL : languages.COM_LOADING_MODEL_COMPONENTS"
                            class="w-3/4"></loading-bar>
                        <div v-else-if="imageGeneration.currentState == 'generating'"
                            class="flex gap-2 items-center justify-center text-white">
                            <span class="svg-icon i-loading w-8 h-8"></span>
                            <span class="text-2xl">{{ imageGeneration.stepText }}</span>
                        </div>
                    </div>
                    <div v-show="imageGeneration.previewIdx != -1 && imageGeneration.generateIdx > imageGeneration.previewIdx"
                        class="absolute bottom-0 -right-8 box-content flex flex-col items-center justify-center gap-2">
                        <button @click="postImageToEnhance" :title="languages.COM_POST_TO_ENHANCE_PROCESS"
                            class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center">
                            <span class="svg-icon text-white i-transfer w-4 h-4"></span>
                        </button>
                        <button v-if="imageGeneration.activeWorkflow.backend === 'default'" @click="showParamsDialog" :title="languages.COM_OPEN_PARAMS"
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
                        <button v-show="!imageGeneration.processing" @click="reset" :title="languages.COM_DELETE"
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
                :placeholder="languages.COM_SD_PROMPT" v-model="imageGeneration.prompt" @keydown.enter.prevent="generateImage"></textarea>
            <button class="gernate-btn self-stretch flex flex-col w-32 flex-none" v-show="!imageGeneration.processing"
                @click="generateImage">
                <span class="svg-icon i-generate-add w-7 h-7"></span>
                <span>{{ languages.COM_GENERATE }}</span>
            </button>
            <button class="gernate-btn self-stretch flex flex-col w-32 flex-none" v-show="imageGeneration.processing"
                @click="imageGeneration.stop">
                <span class="svg-icon w-7 h-7" :class="{ 'i-stop': !imageGeneration.stopping, 'i-loading': imageGeneration.stopping }"></span>
                <span>{{ languages.COM_STOP }}</span>
            </button>
        </div>
    </div>
</template>
<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n';
import { toast } from '@/assets/js/toast';
import { util } from '@/assets/js/util';
import LoadingBar from "../components/LoadingBar.vue";
import PaintInfo from '@/components/PaintInfo.vue';
import { useImageGeneration } from '@/assets/js/store/imageGeneration';
import { useStableDiffusion } from '@/assets/js/store/stableDiffusion';


const imageGeneration = useImageGeneration();
const stableDiffusion = useStableDiffusion();
const i18nState = useI18N().state;
const downloadModel = reactive({
    downloading: false,
    text: "",
    percent: 0
});
const showParams = ref(false);
const infoParams = ref<KVObject>({})

const emits = defineEmits<{
    (e: "showDownloadModelConfirm", downloadList: DownloadModelParam[], success?: () => void, fail?: () => void): void,
    (e: "postImageToEnhance", url: string): void
}>();

async function generateImage() {
  await ensureModelsAreAvailable();
  reset();
  await imageGeneration.generate();
}

async function ensureModelsAreAvailable() {
  return new Promise<void>(async (resolve, reject) => {
    const downloadList = await imageGeneration.getMissingModels();
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



function postImageToEnhance() {
    emits("postImageToEnhance", imageGeneration.imageUrls[imageGeneration.previewIdx]);
}

function openImage() {
    const path = imageGeneration.imageUrls[imageGeneration.previewIdx];
    window.electronAPI.openImageWithSystem(path);

}

function selecteImage() {
    window.electronAPI.selecteImage(imageGeneration.imageUrls[imageGeneration.previewIdx]);
}


function copyImage() {
    util.copyImage(imageGeneration.imageUrls[imageGeneration.previewIdx]);
    toast.success(i18nState.COM_COPY_SUCCESS_TIP);
}

function reset() {
    downloadModel.downloading = false;
    imageGeneration.reset();
}

function swithPreview(i: number) {
    imageGeneration.previewIdx = i;
    if (i > -1) {
        infoParams.value = stableDiffusion.generateParams[i];
    } else {
        showParams.value = false;
    }
}

function showParamsDialog() {
      showParams.value = true;
      infoParams.value = stableDiffusion.generateParams[imageGeneration.previewIdx];
}
</script>