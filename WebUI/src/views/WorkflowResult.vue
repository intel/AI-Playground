<template>
  <div
    v-if="imageGeneration.processing || currentImage"
    id="createPanel"
    class="h-full flex flex-col p-4"
  >
    <div class="image-panel justify-center items-center flex-auto flex relative pr-6">
      <div
        class="flex justify-center items-center relative bg-accent rounded-lg border border-border"
        style="width: min(768px, 100%); height: min(512px, 100%); aspect-ratio: 3/2"
      >
        <!-- eslint-disable vue/require-v-for-key -->
        <div
          v-show="imageGeneration.generatedImages.length > 0 && currentImage"
          class="flex justify-center items-center w-full h-full relative"
          :draggable="currentImage && !is3D(currentImage) ? true : false"
          @dragstart="(e) => dragImage(currentImage)(e)"
        >
          <!-- eslint-enable -->
          <!-- Modern placeholder for queued/generating images without preview (exclude stopped) -->
          <div
            v-if="
              currentImage &&
              currentImage.type === 'image' &&
              currentImage.state !== 'stopped' &&
              (currentImage.state === 'queued' || currentImage.state === 'generating') &&
              !hasValidImageUrl(currentImage)
            "
            class="w-full h-full flex items-center justify-center bg-gradient-to-br from-accent/30 to-muted/20"
          >
            <div class="flex flex-col items-center justify-center gap-4">
              <Spinner class="w-16 h-16 text-primary/40" />
            </div>
          </div>
          <img
            v-else-if="
              currentImage && currentImage.type === 'image' && hasValidImageUrl(currentImage)
            "
            class="w-full h-full object-contain p-2"
            :src="currentImage.imageUrl"
          />
          <!-- NSFW Blocked Overlay -->
          <div
            v-if="currentImage && currentImage.type === 'image' && isCurrentImageNsfwBlocked"
            class="absolute inset-0 flex items-center justify-center m-2 rounded"
          >
            <div class="text-center">
              <span class="text-white text-3xl font-medium">NSFW Result<br />Blocked</span>
            </div>
          </div>
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
          <ImageGenerationProgress
            v-else-if="
              currentImage &&
              currentImage.state !== 'stopped' &&
              (currentImage.state === 'generating' || currentImage.state === 'queued')
            "
            :step-text="imageGeneration.stepText"
          />
        </div>
        <div
          v-show="
            currentImage && (!(currentImage?.state === 'generating') || !imageGeneration.processing)
          "
          class="absolute bottom-0 -right-8 box-content flex flex-col items-center justify-center gap-2"
        >
          <IconButton
            v-if="
              currentImage &&
              currentImage?.state !== 'generating' &&
              (props.mode === 'imageGen' || props.mode === 'imageEdit')
            "
            icon="i-transfer"
            :tooltip="languages.COM_POST_TO_IMAGE_EDIT"
            @click="postImageToMode(currentImage, 'imageEdit')"
          />
          <IconButton
            v-if="
              currentImage &&
              currentImage?.state !== 'generating' &&
              (props.mode === 'imageGen' || props.mode === 'imageEdit') &&
              !is3D(currentImage)
            "
            icon="i-video"
            :tooltip="languages.COM_POST_TO_VIDEO"
            @click="postImageToMode(currentImage, 'video')"
          />
          <IconButton
            v-show="currentImage && !(currentImage?.state === 'generating')"
            icon="i-info"
            :tooltip="languages.COM_OPEN_PARAMS"
            @click="showParamsDialog"
          />
          <IconButton
            v-if="currentImage && !(currentImage?.state === 'generating')"
            icon="i-zoom-in"
            :tooltip="languages.COM_ZOOM_IN"
            @click="openImage(currentImage)"
          />
          <IconButton
            v-if="currentImage && !(currentImage?.state === 'generating')"
            icon="i-copy"
            :tooltip="languages.COM_COPY"
            @click="copyImage(currentImage)"
          />
          <IconButton
            v-if="currentImage && !(currentImage?.state === 'generating')"
            icon="i-folder"
            :tooltip="languages.COM_OPEN_LOCATION"
            @click="openImageInFolder(currentImage)"
          />
          <IconButton
            v-if="currentImage"
            icon="i-delete"
            :tooltip="languages.COM_DELETE"
            @click="deleteImage(currentImage)"
          />
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
import ImageGenerationProgress from '@/components/ImageGenerationProgress.vue'
import { Spinner } from '@/components/ui/spinner'
import {
  MediaItem,
  isVideo,
  is3D,
  useImageGenerationPresets,
} from '@/assets/js/store/imageGenerationPresets'
import Model3DViewer from '@/components/Model3DViewer.vue'
import IconButton from '@/components/ui/IconButton.vue'
import { usePromptStore } from '@/assets/js/store/promptArea.ts'
import { checkIfNsfwBlocked } from '@/lib/utils'

interface Props {
  mode: WorkflowModeType
}

const props = defineProps<Props>()
const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const i18nState = useI18N().state
const showInfoParams = ref(false)
const isCurrentImageNsfwBlocked = ref(false)

const selectedImageIdKey = computed(() => {
  switch (props.mode) {
    case 'imageGen':
      return 'selectedGeneratedImageId'
    case 'imageEdit':
      return 'selectedEditedImageId'
    case 'video':
      return 'selectedVideoId'
  }
})

const currentImage = computed<MediaItem | null>(() => {
  return (
    imageGeneration.generatedImages.find(
      (image) => image.id === imageGeneration[selectedImageIdKey.value],
    ) ?? null
  )
})

// Check if imageUrl is the transparent placeholder
const isPlaceholderUrl = (url: string | undefined): boolean => {
  if (!url || url.trim() === '') return true
  const placeholderUrl =
    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"%3E%3C/svg%3E'
  return url === placeholderUrl
}

const hasValidImageUrl = (image: MediaItem | null): boolean => {
  if (!image || image.type !== 'image') return false
  return !isPlaceholderUrl(image.imageUrl)
}

// Check if current image is NSFW blocked when it changes
watch(
  () => currentImage.value,
  async (newImage) => {
    if (newImage && newImage.type === 'image' && newImage.state === 'done') {
      // Check if already marked
      if (newImage.isNsfwBlocked !== undefined) {
        isCurrentImageNsfwBlocked.value = newImage.isNsfwBlocked
      } else {
        // Check the image and cache the result
        const isBlocked = await checkIfNsfwBlocked(newImage.imageUrl)
        isCurrentImageNsfwBlocked.value = isBlocked
        if (isBlocked) {
          // Update the image in the store with the cached result
          newImage.isNsfwBlocked = true
        }
      }
    } else {
      isCurrentImageNsfwBlocked.value = false
    }
  },
  { immediate: true },
)

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
      (i) => i.state !== 'queued' && i.mode === props.mode,
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
  try {
    imageGeneration.prompt = prompt
    await imageGeneration.ensureModelsAreAvailable()
    await imageGeneration.generate(props.mode)
  } catch (error) {
    // Reset state on any error (including download cancellation)
    promptStore.promptSubmitted = false
    imageGeneration.processing = false
    console.error('Error during image generation:', error)
  }
}

function stopGeneration() {
  imageGeneration.stopGeneration()
}

async function postImageToMode(image: MediaItem, mode: WorkflowModeType) {
  await imageGeneration.copyImageAsInputForMode(image, mode)
  promptStore.setCurrentMode(mode)
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
  switch (image.type) {
    case 'video':
      return image.videoUrl
    case 'model3d':
      return image.model3dUrl
    case 'image':
      return image.imageUrl
  }
}
</script>
