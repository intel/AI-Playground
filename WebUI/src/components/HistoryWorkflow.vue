<template>
  <div
    v-if="nonQueuedImagesReversed.length > 0"
    class="flex flex-col space-y-2 pr-3 h-full overflow-y-auto"
  >
    <div
      v-for="image in nonQueuedImagesReversed"
      :key="image.id"
      class="flex items-center gap-2 bg-muted rounded px-3 py-2 cursor-pointer relative border-2 transition-colors hover:bg-muted/80"
      :class="isSelected(image.id) ? 'border-primary' : 'border-transparent'"
      @click="selectImage(image.id)"
    >
      <div
        class="relative w-[150px] h-[90px] overflow-hidden rounded-sm flex items-center justify-center bg-background"
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

        <!-- NSFW Blocked Overlay -->
        <div
          v-if="image.type === 'image' && nsfwBlockedImages.has(image.id)"
          class="absolute inset-0 flex items-center justify-center bg-black/80"
        >
          <span class="text-white text-xs font-medium text-center px-1">NSFW Blocked</span>
        </div>

        <div
          v-else-if="image.type === 'image' && image.sourceImageUrl === image.imageUrl"
          class="absolute bottom-0 w-full bg-background/60 text-foreground text-[14px] text-center py-[2px]"
        >
          {{ languages.ENHANCE_PREVIEW_BEFORE_PROCESS }}
        </div>
      </div>

      <!-- Date display -->
      <div v-if="image.createdAt" class="flex flex-col flex-1 min-w-0">
        <span class="text-xs text-muted-foreground truncate">
          {{ new Date(image.createdAt).toLocaleString() }}
        </span>
      </div>

      <div class="absolute top-1 right-1 flex items-center">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="h-6 w-6" @click.stop>
              <span class="svg-icon i-dots-vertical w-4 h-4"></span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-28">
            <DropdownMenuItem @click.stop="reloadImage(image)"> Reload </DropdownMenuItem>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <DropdownMenuItem @select="(e: Event) => e.preventDefault()">
                  Delete
                </DropdownMenuItem>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {{ languages.COM_DELETE_IMAGE_QUESTION }}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {{ languages.COM_DELETE_IMAGE_EXPLANATION }}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction @click="() => deleteImage(image)">
                    {{ languages.COM_DELETE }}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </div>
  <div v-else class="text-muted-foreground text-center p-5 italic">No images generated yet.</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  useImageGenerationPresets,
  MediaItem,
  isVideo,
  is3D,
} from '@/assets/js/store/imageGenerationPresets'
import Model3DViewer from '@/components/Model3DViewer.vue'
import { checkIfNsfwBlocked } from '@/lib/utils'

const props = defineProps<{
  mode: WorkflowModeType
}>()

const imageGeneration = useImageGenerationPresets()

// Track which images are NSFW blocked
const nsfwBlockedImages = ref<Set<string>>(new Set())

const nonQueuedImagesReversed = computed(() =>
  imageGeneration.generatedImages
    .filter((i) => i.state !== 'queued' && i.mode === props.mode)
    .slice()
    .reverse(),
)

// Check new images for NSFW blocking
watch(
  nonQueuedImagesReversed,
  async (images) => {
    for (const image of images) {
      if (
        image.type === 'image' &&
        image.state === 'done' &&
        !nsfwBlockedImages.value.has(image.id)
      ) {
        // Check if already marked in the image object
        if (image.isNsfwBlocked !== undefined) {
          if (image.isNsfwBlocked) {
            nsfwBlockedImages.value.add(image.id)
          }
        } else {
          // Check the image
          const isBlocked = await checkIfNsfwBlocked(image.imageUrl)
          if (isBlocked) {
            nsfwBlockedImages.value.add(image.id)
            // Cache the result in the image object
            image.isNsfwBlocked = true
          }
        }
      }
    }
  },
  { immediate: true, deep: true },
)

const dragImage = (item: MediaItem | null) => (event: DragEvent) => {
  if (!item) return
  event.preventDefault()
  let url: string
  if (isVideo(item)) {
    url = item.videoUrl
  } else if (is3D(item)) {
    url = item.model3dUrl
  } else if (item.type === 'image') {
    url = item.imageUrl
  } else {
    url = ''
  }
  window.electronAPI.startDrag(url)
}

// todo: not used
function reloadImage(image: MediaItem) {
  console.log('Reloading image:', image.id)
}

function deleteImage(image: MediaItem) {
  console.log('Deleting image:', image.id)
  imageGeneration.deleteImage(image.id)
}

function isSelected(id: string) {
  if (props.mode === 'imageGen') return imageGeneration.selectedGeneratedImageId === id
  if (props.mode === 'imageEdit') return imageGeneration.selectedEditedImageId === id
  if (props.mode === 'video') return imageGeneration.selectedVideoId === id
  return false
}

function selectImage(id: string) {
  if (props.mode === 'imageGen') imageGeneration.selectedGeneratedImageId = id
  else if (props.mode === 'imageEdit') imageGeneration.selectedEditedImageId = id
  else if (props.mode === 'video') imageGeneration.selectedVideoId = id
}
</script>

<style scoped></style>
