<template>
  <div v-if="processing || currentImage" class="flex flex-col gap-3">
    <!-- Horizontal Thumbnail Gallery -->
    <div v-if="imagesWithPreview.length > 1" class="flex gap-2 overflow-x-auto pb-2">
      <div
        v-for="image in imagesWithPreview"
        :key="image.id"
        class="flex-shrink-0 cursor-pointer relative border-3 shadow-foreground/40 shadow-md transition-colors rounded-sm overflow-hidden"
        :class="selectedImageId === image.id ? 'border-primary' : 'border-transparent'"
        @click="selectedImageId = image.id"
        style="width: 80px; height: 60px"
      >
        <div
          class="relative w-full h-full flex items-center justify-center bg-background"
          draggable="true"
          @dragstart="(e) => dragImage(image)(e)"
        >
          <video v-if="isVideo(image)" :src="image.videoUrl" class="w-full h-full object-cover" />
          <Model3DViewer v-else-if="is3D(image)" :src="image.model3dUrl" class="w-full h-full" />
          <img
            v-else-if="image.type === 'image'"
            :src="image.imageUrl"
            class="w-full h-full object-cover"
          />

          <!-- State indicator overlay -->
          <div
            v-if="image.state === 'generating' || image.state === 'queued'"
            class="absolute inset-0 bg-background/60 flex items-center justify-center"
          >
            <span class="svg-icon i-loading w-4 h-4 animate-spin"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Image Display -->
    <div class="flex justify-center items-center relative">
      <div class="relative bg-accent rounded-lg min-w-[400px] min-h-[300px]">
        <!-- Media content -->
        <div
          v-show="images.length > 0 && currentImage"
          class="flex justify-center items-center"
          :draggable="currentImage && !is3D(currentImage) ? true : false"
          @dragstart="(e) => dragImage(currentImage)(e)"
        >
          <!-- Placeholder for queued/generating images without preview (exclude stopped) -->
          <div
            v-if="
              currentImage &&
              currentImage.type === 'image' &&
              currentImage.state !== 'stopped' &&
              (currentImage.state === 'queued' || currentImage.state === 'generating') &&
              !hasValidImageUrl(currentImage)
            "
            class="flex items-center justify-center bg-gradient-to-br from-accent/30 to-muted/20 w-[400px] h-[300px] rounded-sm"
          >
            <div class="flex flex-col items-center justify-center gap-4">
              <Spinner class="w-16 h-16 text-primary/40" />
            </div>
          </div>
          <img
            v-else-if="
              currentImage && currentImage.type === 'image' && hasValidImageUrl(currentImage)
            "
            class="object-contain shadow-black/40 shadow-md rounded-sm border-3 border-background"
            :src="currentImage.imageUrl"
          />
          <video
            v-else-if="currentImage && isVideo(currentImage)"
            :src="currentImage?.videoUrl as string"
            class="object-contain p-2"
            controlsList="nodownload nofullscreen noremoteplayback"
            controls
          />
          <Model3DViewer
            v-else-if="currentImage && is3D(currentImage)"
            :src="currentImage?.model3dUrl as string"
            class=""
          />
        </div>

        <!-- Progress overlay (absolutely positioned over the content) -->
        <div
          v-show="processing"
          class="absolute inset-0 flex justify-center items-center rounded-lg"
        >
          <loading-bar
            v-if="
              currentState &&
              [
                'load_model',
                'load_model_components',
                'install_workflow_components',
                'load_workflow_components',
              ].includes(currentState as string)
            "
            :text="loadingStateToText(currentState as string)"
            class="w-3/4"
          ></loading-bar>
          <ImageGenerationProgress
            v-else-if="
              currentImage &&
              currentImage.state !== 'stopped' &&
              (currentImage.state === 'generating' || currentImage.state === 'queued')
            "
            :step-text="stepText || 'Generating...'"
          />
          <ImageGenerationProgress v-else :step-text="stepText || 'Preparing...'" />
        </div>

        <!-- Action buttons (absolutely positioned on the right side) -->
        <div
          v-show="currentImage && (!(currentImage?.state === 'generating') || !processing)"
          class="absolute top-1/2 -translate-y-1/2 -right-8 flex flex-col items-center justify-center gap-2"
        >
          <IconButton
            v-if="currentImage && currentImage.state !== 'generating'"
            icon="i-transfer"
            :tooltip="languages.COM_POST_TO_IMAGE_EDIT"
            @click="postImageToMode(currentImage, 'imageEdit')"
          />
          <IconButton
            v-if="currentImage && currentImage.state !== 'generating' && !is3D(currentImage)"
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
        </div>
      </div>
      <info-table
        v-show="showInfoParams"
        :generationParameters="currentImage?.settings ?? {}"
        :dynamicInputs="currentImage?.dynamicSettings as any"
        @close="showInfoParams = false"
      ></info-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import * as toast from '@/assets/js/toast'
import * as util from '@/assets/js/util'
import LoadingBar from './LoadingBar.vue'
import InfoTable from '@/components/InfoTable.vue'
import ImageGenerationProgress from '@/components/ImageGenerationProgress.vue'
import { Spinner } from '@/components/ui/spinner'
import {
  MediaItem,
  isVideo,
  is3D,
  useImageGenerationPresets,
  type GenerateState,
} from '@/assets/js/store/imageGenerationPresets'
import { usePromptStore } from '@/assets/js/store/promptArea'
import Model3DViewer from '@/components/Model3DViewer.vue'
import IconButton from '@/components/ui/IconButton.vue'

interface Props {
  images: MediaItem[]
  processing: boolean
  currentState?: GenerateState
  stepText?: string
  toolCallId?: string
}

const props = defineProps<Props>()
const i18nState = useI18N().state
const languages = i18nState
const imageGeneration = useImageGenerationPresets()
const promptStore = usePromptStore()
const showInfoParams = ref(false)

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

// Local state for selected image
const selectedImageId = ref<string | null>(null)

// Filter images to only show those with valid URLs
const imagesWithPreview = computed(() => {
  return props.images.filter((img) => {
    if (img.type === 'image') return img.imageUrl && img.imageUrl.trim() !== ''
    if (img.type === 'video') return img.videoUrl && img.videoUrl.trim() !== ''
    if (img.type === 'model3d') return img.model3dUrl && img.model3dUrl.trim() !== ''
    return false
  })
})

// Watch images to auto-select the last one when new images arrive
watch(
  () => imagesWithPreview.value,
  (images) => {
    if (images.length > 0) {
      // Select the last image (most recent) if none selected or selected image is not in list
      const lastImage = images[images.length - 1]
      if (!selectedImageId.value || !images.find((img) => img.id === selectedImageId.value)) {
        selectedImageId.value = lastImage.id
      }
    } else {
      selectedImageId.value = null
    }
  },
  { immediate: true },
)

const currentImage = computed<MediaItem | null>(() => {
  if (!selectedImageId.value) return null
  return imagesWithPreview.value.find((image) => image.id === selectedImageId.value) ?? null
})

const dragImage = (item: MediaItem | null) => (event: Event) => {
  if (!item) return
  event.preventDefault()
  const url = getMediaUrl(item)
  window.electronAPI.startDrag(url)
}

function showParamsDialog() {
  showInfoParams.value = true
  console.log(currentImage.value?.settings)
}

async function postImageToMode(image: MediaItem, mode: WorkflowModeType) {
  await imageGeneration.copyImageAsInputForMode(image, mode)
  promptStore.setCurrentMode(mode)
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
