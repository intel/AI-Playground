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
      <div class="flex justify-center items-center relative bg-accent rounded-lg gap-2" style="">
        <div
          v-show="images.length > 0 && currentImage"
          class="flex justify-center items-center"
          :draggable="currentImage && !is3D(currentImage) ? true : false"
          @dragstart="(e) => dragImage(currentImage)(e)"
        >
          <img
            v-if="currentImage && currentImage.type === 'image'"
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
        <div v-show="processing" class="w-full h-full flex justify-center items-center">
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
          <div
            v-else-if="currentImage?.state === 'generating' || currentImage?.state === 'queued'"
            class="flex gap-2 items-center justify-center text-foreground bg-background/50 py-6 px-12 rounded-lg"
          >
            <span class="svg-icon i-loading w-8 h-8"></span>
            <span class="text-2xl tabular-nums" style="min-width: 200px">{{
              stepText || 'Generating...'
            }}</span>
          </div>
          <div
            v-else
            class="flex gap-2 items-center justify-center text-foreground bg-background/50 py-6 px-12 rounded-lg"
          >
            <span class="svg-icon i-loading w-8 h-8"></span>
            <span class="text-2xl tabular-nums" style="min-width: 200px">{{
              stepText || 'Preparing...'
            }}</span>
          </div>
        </div>
        <div
          v-show="currentImage && (!(currentImage?.state === 'generating') || !processing)"
          class="flex flex-col items-center justify-center gap-2"
        >
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
import {
  MediaItem,
  isVideo,
  is3D,
  type GenerateState,
} from '@/assets/js/store/imageGenerationPresets'
import Model3DViewer from '@/components/Model3DViewer.vue'

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
const showInfoParams = ref(false)

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
