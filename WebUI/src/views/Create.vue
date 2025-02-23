<template>
  <div id="createPanel" class="h-full flex flex-col p-4">
    <div class="image-panel justify-center items-center flex-auto flex">
      <div
        v-show="imageGeneration.generatedImages.length > 0"
        class="flex flex-row justify-center items-end h-full"
        style="height: 550px !important"
      >
        <div class="image-preview-panel">
          <!-- eslint-disable vue/require-v-for-key -->
          <div
            v-for="image in imageGeneration.generatedImages"
            class="image-preview-item flex items-center justify-center"
            :class="{ active: selectedImageId === image.id }"
            @click="selectedImageId = image.id"
          >
            <!-- eslint-enable -->
            <div class="image-preview-item-bg">
              <img :src="image.imageUrl" class="image-thumb" />
            </div>
          </div>
        </div>
        <div class="items-end justify-end">
          <button
            @click="deleteAllImages"
            :title="languages.COM_CLEAR_HISTORY"
            :disabled="imageGeneration.processing"
            class="bg-color-image-tool-button rounded-sm w-6 h-6 ml-2 flex items-center justify-center"
          >
            <span class="svg-icon text-white i-clear w-4 h-4"></span>
          </button>
        </div>
      </div>
      <div class="flex-auto relative flex items-center justify-center">
        <div
          class="flex justify-center items-center w-768px h-512px relative bg-color-image-bg rounded-lg border border-white/30"
        >
          <!-- eslint-disable vue/require-v-for-key -->
          <div
            v-for="image in imageGeneration.generatedImages"
            v-show="selectedImageId === image.id"
          >
            <!-- eslint-enable -->
            <img class="p-1 max-w-768px max-h-512px" v-if="!isVideo(image)" :src="image.imageUrl" />
            <video class="p-1 max-w-768px max-h-512px" v-else controls>
              <source :src="image.videoUrl" :type="image.videoFormat" />
            </video>
          </div>
          <div
            v-show="imageGeneration.processing"
            class="absolute left-0 top-0 w-full h-full bg-black/50 flex justify-center items-center"
          >
            <loading-bar
              v-if="
                [
                  'load_model',
                  'load_model_components',
                  'install_workflow_components',
                  'load_workflow_components',
                ].includes(imageGeneration.currentState)
              "
              :text="loadingStateToText(imageGeneration.currentState)"
              class="w-3/4"
            ></loading-bar>
            <div
              v-else-if="imageGeneration.currentState == 'generating'"
              class="flex gap-2 items-center justify-center text-white"
            >
              <span class="svg-icon i-loading w-8 h-8"></span>
              <span class="text-2xl">{{ imageGeneration.stepText }}</span>
            </div>
          </div>
          <div
            v-show="
              currentImage &&
              (!(currentImage?.state === 'generating') || !imageGeneration.processing)
            "
            class="absolute bottom-0 -right-8 box-content flex flex-col items-center justify-center gap-2"
          >
            <button
              v-show="
                currentImage && !(currentImage?.state === 'generating') && !isVideo(currentImage)
              "
              @click="postImageToEnhance"
              :title="languages.COM_POST_TO_ENHANCE_PROCESS"
              class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-transfer w-4 h-4"></span>
            </button>
            <button
              v-show="currentImage && !(currentImage?.state === 'generating')"
              @click="showParamsDialog"
              :title="languages.COM_OPEN_PARAMS"
              class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-info w-4 h-4"></span>
            </button>
            <button
              v-show="currentImage && !(currentImage?.state === 'generating')"
              @click="openImage"
              :title="languages.COM_ZOOM_IN"
              class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-zoom-in w-4 h-4"></span>
            </button>
            <button
              v-show="currentImage && !(currentImage?.state === 'generating')"
              @click="copyImage"
              :title="languages.COM_COPY"
              class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-copy w-4 h-4"></span>
            </button>
            <button
              v-show="currentImage && !(currentImage?.state === 'generating')"
              @click="openImageInFolder"
              :title="languages.COM_OPEN_LOCATION"
              class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-folder w-4 h-4"></span>
            </button>
            <button
              @click="deleteImage"
              :title="languages.COM_DELETE"
              class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-delete w-4 h-4"></span>
            </button>
          </div>
        </div>
        <info-table
          v-show="showInfoParams"
          :generationParameters="currentImage?.settings ?? {}"
          :dynamicInputs="currentImage?.dynamicSettings"
          @close="showInfoParams = false"
        ></info-table>
      </div>
    </div>
    <div class="h-32 gap-3 flex-none flex items-center">
      <textarea
        class="rounded-xl border border-color-spilter flex-auto h-full resize-none"
        :placeholder="languages.COM_SD_PROMPT"
        v-model="imageGeneration.prompt"
        @keydown.enter.prevent="generateImage"
      ></textarea>
      <button
        class="gernate-btn self-stretch flex flex-col w-32 flex-none"
        v-show="!imageGeneration.processing"
        @click="generateImage"
      >
        <span class="svg-icon i-generate-add w-7 h-7"></span>
        <span>{{ languages.COM_GENERATE }}</span>
      </button>
      <button
        class="gernate-btn self-stretch flex flex-col w-32 flex-none"
        v-show="imageGeneration.processing"
        @click="imageGeneration.stopGeneration"
      >
        <span
          class="svg-icon w-7 h-7"
          :class="{ 'i-stop': !imageGeneration.stopping, 'i-loading': imageGeneration.stopping }"
        ></span>
        <span>{{ languages.COM_STOP }}</span>
      </button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import * as toast from '@/assets/js/toast'
import * as util from '@/assets/js/util'
import LoadingBar from '../components/LoadingBar.vue'
import InfoTable from '@/components/InfoTable.vue'
import { Media, isVideo, useImageGeneration } from '@/assets/js/store/imageGeneration'

const imageGeneration = useImageGeneration()
const i18nState = useI18N().state
const showInfoParams = ref(false)
const selectedImageId = ref<string | null>(null)
const currentImage: ComputedRef<Media | null> = computed(() => {
  return imageGeneration.generatedImages.find((image) => image.id === selectedImageId.value) ?? null
})
watch(
  () => imageGeneration.generatedImages.length,
  () => {
    const numberOfImages = imageGeneration.generatedImages.length
    if (numberOfImages > 0) {
      selectedImageId.value = imageGeneration.generatedImages[numberOfImages - 1].id
    } else {
      selectedImageId.value = null
    }
    showInfoParams.value = false
  },
)

const emits = defineEmits<{
  (
    e: 'showDownloadModelConfirm',
    downloadList: DownloadModelParam[],
    success?: () => void,
    fail?: () => void,
  ): void
  (e: 'postImageToEnhance', url: string): void
}>()

async function generateImage() {
  await ensureModelsAreAvailable()
  await imageGeneration.generate()
}

async function ensureModelsAreAvailable() {
  return new Promise<void>(async (resolve, reject) => {
    const downloadList = await imageGeneration.getMissingModels()
    if (downloadList.length > 0) {
      emits('showDownloadModelConfirm', downloadList, resolve, reject)
    } else {
      resolve()
    }
  })
}

function postImageToEnhance() {
  emits('postImageToEnhance', getMediaUrl(currentImage.value!))
}

function showParamsDialog() {
  showInfoParams.value = true
  console.log(currentImage.value?.settings)
}

function openImage() {
  window.electronAPI.openImageWithSystem(getMediaUrl(currentImage.value!))
}

function copyImage() {
  util.copyImage(getMediaUrl(currentImage.value!))
  toast.success(i18nState.COM_COPY_SUCCESS_TIP)
}

function openImageInFolder() {
  window.electronAPI.openImageInFolder(getMediaUrl(currentImage.value!))
}

function deleteImage() {
  if (!currentImage.value) return
  imageGeneration.deleteImage(currentImage.value.id)
}

function deleteAllImages() {
  imageGeneration.deleteAllImages()
}

function loadingStateToText(state: string) {
  switch (state) {
    case 'load_model':
      return i18nState.COM_LOADING_MODEL
    case 'load_model_components':
      return i18nState.COM_LOADING_MODEL_COMPONENTS
    case 'install_workflow_components':
      return i18nState.COM_INSTALL_WORKFLOW_COMPONENTS
    case 'load_workflow_components':
      return i18nState.COM_LOADING_WORKFLOW_COMPONENTS
    default:
      return state
  }
}

function getMediaUrl(image: Media) {
  return isVideo(image) ? image.videoUrl : image.imageUrl
}
</script>
