<template>
  <div
    v-if="imageGeneration.processing || currentImage"
    id="createPanel"
    class="h-full flex flex-col p-4"
  >
    <div class="image-panel justify-center items-center flex-auto flex relative pr-6">
      <div
        class="flex justify-center items-center relative bg-accent rounded-lg border border-border"
        style="width: min(768px, 100%); height: min(512px, 100%); aspect-ratio: 3/2;"
      >
        <!-- eslint-disable vue/require-v-for-key -->
        <div
          v-show="imageGeneration.generatedImages.length > 0 && currentImage"
          class="flex justify-center items-center w-full h-full"
          :draggable="currentImage && !is3D(currentImage) ? true : false"
          @dragstart="(e) => dragImage(currentImage)(e)"
        >
          <!-- eslint-enable -->
          <img
            v-if="currentImage && !isVideo(currentImage) && !is3D(currentImage)"
            class="w-full h-full object-contain p-2"
            :src="currentImage?.imageUrl"
          />
          <video
            v-else-if="currentImage && isVideo(currentImage)"
            :src="currentImage?.videoUrl as string"
            class="w-full h-full object-contain p-2"
            controlsList="nodownload nofullscreen noremoteplayback"
            controls
          />
          <Model3DViewer
            v-else-if="currentImage && is3D(currentImage)"
            :src="currentImage?.model3dUrl as string"
            class="w-full h-full"
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
            class="flex gap-2 items-center justify-center text-foreground bg-background/50 py-6 px-12 rounded-lg"
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
                currentImage && currentImage?.state !== 'generating' && props.mode === 'imageGen'
              "
            @click="postImageToMode(currentImage, 'imageEdit')"
            :title="languages.COM_POST_TO_IMAGE_EDIT"
            class="bg-muted rounded-xs w-6 h-6 flex items-center justify-center"
          >
            <span class="svg-icon text-foreground i-transfer w-4 h-4"></span>
          </button>
          <button
            v-if="
                currentImage && currentImage?.state !== 'generating' && (props.mode === 'imageGen' || props.mode === 'imageEdit') && !is3D(currentImage)
              "
            @click="postImageToMode(currentImage, 'video')"
            :title="languages.COM_POST_TO_VIDEO"
            class="bg-muted rounded-xs w-6 h-6 flex items-center justify-center"
          >
            <span class="svg-icon text-foreground i-video w-4 h-4"></span>
          </button>
          <button
            v-show="currentImage && !(currentImage?.state === 'generating')"
            @click="showParamsDialog"
            :title="languages.COM_OPEN_PARAMS"
            class="bg-muted rounded-xs w-6 h-6 flex items-center justify-center"
          >
            <span class="svg-icon text-foreground i-info w-4 h-4"></span>
          </button>
          <button
            v-if="currentImage && !(currentImage?.state === 'generating')"
            @click="openImage(currentImage)"
            :title="languages.COM_ZOOM_IN"
            class="bg-muted rounded-xs w-6 h-6 flex items-center justify-center"
          >
            <span class="svg-icon text-foreground i-zoom-in w-4 h-4"></span>
          </button>
          <button
            v-if="currentImage && !(currentImage?.state === 'generating')"
            @click="copyImage(currentImage)"
            :title="languages.COM_COPY"
            class="bg-muted rounded-xs w-6 h-6 flex items-center justify-center"
          >
            <span class="svg-icon text-foreground i-copy w-4 h-4"></span>
          </button>
          <button
            v-if="currentImage && !(currentImage?.state === 'generating')"
            @click="openImageInFolder(currentImage)"
            :title="languages.COM_OPEN_LOCATION"
            class="bg-muted rounded-xs w-6 h-6 flex items-center justify-center"
          >
            <span class="svg-icon text-foreground i-folder w-4 h-4"></span>
          </button>
          <button
            v-if="currentImage"
            @click="deleteImage(currentImage)"
            :title="languages.COM_DELETE"
            class="bg-muted rounded-xs w-6 h-6 flex items-center justify-center"
          >
            <span class="svg-icon text-foreground i-delete w-4 h-4"></span>
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
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import * as toast from '@/assets/js/toast'
import * as util from '@/assets/js/util'
import LoadingBar from '../components/LoadingBar.vue'
import InfoTable from '@/components/InfoTable.vue'
import { MediaItem, isVideo, is3D, useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import Model3DViewer from '@/components/Model3DViewer.vue'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { usePromptStore } from "@/assets/js/store/promptArea.ts"

interface Props {
  mode: WorkflowModeType
}

const props = defineProps<Props>()
const dialogStore = useDialogStore()
const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const i18nState = useI18N().state
const showInfoParams = ref(false)

const selectedImageIdKey = computed(() => {
    switch (props.mode) {
      case 'imageGen':
        return 'selectedGeneratedImageId'
      case 'imageEdit':
        return 'selectedEditedImageId'
      case 'video':
        return 'selectedVideoId'
    }
  }
)

const currentImage = computed<MediaItem | null>(() => {
  return imageGeneration.generatedImages.find(
    (image) => image.id === imageGeneration[selectedImageIdKey.value]
  ) ?? null
})

const dragImage = (item: MediaItem | null) => (event: Event) => {
  if (!item) return
  event.preventDefault()
  const url = getMediaUrl(item)
  window.electronAPI.startDrag(url)
}

onMounted(() => {
  promptStore.registerSubmitCallback(props.mode, generateImage)
  promptStore.registerCancelCallback(props.mode, stopGeneration)
})

onUnmounted(() => {
  promptStore.unregisterSubmitCallback(props.mode)
  promptStore.unregisterCancelCallback(props.mode)
})

watch(
  () => imageGeneration.generatedImages.filter((i) => i.state !== 'queued').length,
  () => {
    const nonQueuedImages = imageGeneration.generatedImages.filter(
      (i) => i.state !== 'queued' && i.mode === props.mode
    )
    if (nonQueuedImages.length > 0) {
      imageGeneration[selectedImageIdKey.value] = nonQueuedImages[nonQueuedImages.length - 1].id
    } else {
      imageGeneration[selectedImageIdKey.value] = null
    }
    showInfoParams.value = false
  },
)

async function generateImage(prompt: string) {
  imageGeneration.prompt = prompt
  await ensureModelsAreAvailable()
  await imageGeneration.generate(props.mode)
}

function stopGeneration() {
  imageGeneration.stopGeneration()
}

async function ensureModelsAreAvailable() {
  return new Promise<void>(async (resolve, reject) => {
    const downloadList = await imageGeneration.getMissingModels()
    if (downloadList.length > 0) {
      dialogStore.showDownloadDialog(downloadList, resolve, reject)
    } else {
      resolve()
    }
  })
}

async function postImageToMode(image: MediaItem, mode: WorkflowModeType) {
  promptStore.setCurrentMode(mode)

  const mewImage: MediaItem = {...image}
  mewImage.mode = mode
  mewImage.sourceImageUrl = mewImage.imageUrl

  imageGeneration.generatedImages.push(mewImage)
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
  if (isVideo(image)) return image.videoUrl
  if (is3D(image)) return image.model3dUrl
  return image.imageUrl
}
</script>
