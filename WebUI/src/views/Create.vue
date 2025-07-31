<template>
  <div id="createPanel" class="h-full flex flex-col p-4">
    <div class="image-panel justify-center items-center flex-auto flex">
      <div
        v-show="imageGeneration.generatedImages.filter((i) => i.state !== 'queued').length > 0"
        class="flex flex-row justify-center items-end h-full"
        style="height: 550px !important"
      >
        <div class="image-preview-panel">
          <!-- eslint-disable vue/require-v-for-key -->
          <div
            v-for="image in imageGeneration.generatedImages.filter((i) => i.state !== 'queued')"
            class="image-preview-item flex items-center justify-center"
            :class="{ active: selectedImageId === image.id }"
            @click="() => { selectedImageId = image.id }"
          >
            <!-- eslint-enable -->
            <div class="image-preview-item-bg"
            draggable="true"
            @dragstart="(e) => dragImage(image)(e)">
              <video v-if="isVideo(image)" :src="image.videoUrl" class="image-thumb" />
              <img v-else :src="image.imageUrl" class="image-thumb" />
            </div>
          </div>
        </div>
        <div class="items-end justify-end">
          <button
            @click="deleteAllImages"
            :title="languages.COM_CLEAR_HISTORY"
            :disabled="imageGeneration.processing"
            class="bg-color-image-tool-button rounded-xs w-6 h-6 ml-2 flex items-center justify-center"
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
            v-show="imageGeneration.generatedImages.length > 0 && currentImage"
            class="flex justify-center items-center"
            draggable="true"
            @dragstart="(e) => dragImage(currentImage)(e)"
          >
            <!-- eslint-enable -->
            <img
              v-if="currentImage && !isVideo(currentImage)"
              class="max-w-768px max-h-512px object-contain p-2"
              :src="currentImage?.imageUrl"
            />
            <video
              v-else
              :src="currentImage?.videoUrl as string"
              class="max-w-768px max-h-512px object-contain p-2"
              controlsList="nodownload nofullscreen noremoteplayback"
              controls
            />
          </div>
          <div
            v-show="imageGeneration.processing"
            class="absolute left-0 top-0 w-full h-full flex justify-center items-center"
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
              v-else-if="currentImage?.state === 'generating' || currentImage?.state === 'queued'"
              class="flex gap-2 items-center justify-center text-white bg-black/50 py-6 px-12 rounded-lg"
            >
              <span class="svg-icon i-loading w-8 h-8"></span>
              <span class="text-2xl tabular-nums" style="min-width: 200px">{{
                imageGeneration.stepText
              }}</span>
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
              v-if="
                currentImage && !(currentImage?.state === 'generating') && !isVideo(currentImage)
              "
              @click="postImageToEnhance(currentImage)"
              :title="languages.COM_POST_TO_ENHANCE_PROCESS"
              class="bg-color-image-tool-button rounded-xs w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-transfer w-4 h-4"></span>
            </button>
            <button
              v-show="currentImage && !(currentImage?.state === 'generating')"
              @click="showParamsDialog"
              :title="languages.COM_OPEN_PARAMS"
              class="bg-color-image-tool-button rounded-xs w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-info w-4 h-4"></span>
            </button>
            <button
              v-if="currentImage && !(currentImage?.state === 'generating')"
              @click="openImage(currentImage)"
              :title="languages.COM_ZOOM_IN"
              class="bg-color-image-tool-button rounded-xs w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-zoom-in w-4 h-4"></span>
            </button>
            <button
              v-if="currentImage && !(currentImage?.state === 'generating')"
              @click="copyImage(currentImage)"
              :title="languages.COM_COPY"
              class="bg-color-image-tool-button rounded-xs w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-copy w-4 h-4"></span>
            </button>
            <button
              v-if="currentImage && !(currentImage?.state === 'generating')"
              @click="openImageInFolder(currentImage)"
              :title="languages.COM_OPEN_LOCATION"
              class="bg-color-image-tool-button rounded-xs w-6 h-6 flex items-center justify-center"
            >
              <span class="svg-icon text-white i-folder w-4 h-4"></span>
            </button>
            <button
              v-if="currentImage"
              @click="deleteImage(currentImage)"
              :title="languages.COM_DELETE"
              class="bg-color-image-tool-button rounded-xs w-6 h-6 flex items-center justify-center"
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
    <div class="pt-2 gap-y-2 flex flex-col border-t border-color-spilter">
      <div class="w-full flex flex-wrap items-center gap-y-2 gap-x-4 text-white">
        <div class="flex items-center gap-2">
          <ModeSelector
            v-if="imageGeneration.activeWorkflow.backend === 'default'"
            :title="`${languages.SETTINGS_MODEL_IMAGE_RESOLUTION} & ${languages.SETTINGS_MODEL_QUALITY}`"
            @change="(item) => (imageGeneration.activeWorkflowName = item)"
            :value="imageGeneration.activeWorkflowName ?? 'Standard'"
            :items="[
              { label: 'Standard', value: 'Standard' },
              { label: 'Standard - Fast', value: 'Standard - Fast' },
              { label: 'HD', value: 'HD' },
              { label: 'HD - Fast', value: 'HD - Fast' },
            ]"
          ></ModeSelector>
        </div>
      </div>
      <div
        class="h-32 gap-3 flex-none flex items-center"
        :class="{ 'demo-number-overlay': demoMode.create.show }"
      >
        <textarea
          class="rounded-xl border border-color-spilter flex-auto h-full resize-none"
          :placeholder="languages.COM_SD_PROMPT"
          v-model="imageGeneration.prompt"
          @keydown.enter.prevent="generateImage"
          :class="{ 'demo-mode-overlay-content': demoMode.create.show }"
        ></textarea>
        <DemoNumber :show="demoMode.create.show" :number="1"></DemoNumber>
        <button
          class="gernate-btn self-stretch flex flex-col w-32 flex-none"
          v-show="!imageGeneration.processing"
          @click="generateImage"
          :class="{ 'demo-mode-overlay-content': demoMode.create.show }"
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
  </div>
</template>
<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import * as toast from '@/assets/js/toast'
import * as util from '@/assets/js/util'
import ModeSelector from '@/components/ModeSelector.vue'
import DemoNumber from '@/components/demo-mode/DemoNumber.vue'
import LoadingBar from '../components/LoadingBar.vue'
import InfoTable from '@/components/InfoTable.vue'
import { MediaItem, isVideo, useImageGeneration } from '@/assets/js/store/imageGeneration'
import { useDemoMode } from '@/assets/js/store/demoMode'

const demoMode = useDemoMode()
const imageGeneration = useImageGeneration()
const i18nState = useI18N().state
const showInfoParams = ref(false)
const selectedImageId = ref<string | null>(null)
const currentImage: ComputedRef<MediaItem | null> = computed(() => {
  return imageGeneration.generatedImages.find((image) => image.id === selectedImageId.value) ?? null
})

const dragImage = (item: MediaItem | null) => (event: Event) => {
  if (!item) return;
  event.preventDefault()
  const url = isVideo(item) ? item.videoUrl : item.imageUrl
  window.electronAPI.startDrag(url)
}

watch(
  () => imageGeneration.generatedImages.filter((i) => i.state !== 'queued').length,
  () => {
    const numberOfImages = imageGeneration.generatedImages.filter(
      (i) => i.state !== 'queued',
    ).length
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

function postImageToEnhance(image: MediaItem) {
  emits('postImageToEnhance', getMediaUrl(image))
}

function showParamsDialog() {
  showInfoParams.value = true
  console.log(currentImage.value?.settings)
}

function openImage(image: MediaItem) {
  window.electronAPI.openImageWithSystem(getMediaUrl(image))
}

function copyImage(image: MediaItem) {
  util.copyImage(getMediaUrl(image))
  toast.success(i18nState.COM_COPY_SUCCESS_TIP)
}

function openImageInFolder(image: MediaItem) {
  window.electronAPI.openImageInFolder(getMediaUrl(image))
}

function deleteImage(image: MediaItem) {
  imageGeneration.deleteImage(image.id)
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

function getMediaUrl(image: MediaItem) {
  return isVideo(image) ? image.videoUrl : image.imageUrl
}
</script>
