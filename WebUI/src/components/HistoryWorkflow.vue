<template>
  <div
    v-if="nonQueuedImages.length > 0"
    class="flex flex-col space-y-2 pr-3 h-full overflow-y-auto"
  >
    <div
      v-for="image in nonQueuedImages"
      :key="image.id"
      class="flex items-center gap-2 bg-gray-700 rounded px-3 py-2 cursor-pointer relative border-2 transition-colors hover:bg-gray-600"
      :class="isSelected(image.id) ? 'border-blue-500' : 'border-transparent'"
      @click="selectImage(image.id)"
    >
      <div
        class="relative w-[150px] h-[90px] overflow-hidden rounded-sm flex items-center justify-center bg-black"
        draggable="true"
        @dragstart="(e) => dragImage(image)(e)"
      >
        <video v-if="isVideo(image)" :src="image.videoUrl" class="w-full h-full object-cover" />
        <img v-else :src="image.imageUrl" class="w-full h-full object-cover" />

        <div
          v-if="image.sourceImageUrl === image.imageUrl"
          class="absolute bottom-0 w-full bg-black/60 text-white text-[14px] text-center py-[2px]"
        >
          {{ languages.ENHANCE_PREVIEW_BEFORE_PROCESS }}
        </div>
      </div>

      <div class="absolute top-1 right-1 flex items-center">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="h-6 w-6" @click.stop>
              <span class="svg-icon i-dots-vertical w-4 h-4"></span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-28">
            <DropdownMenuItem @click.stop="reloadImage(image)">
              Reload
            </DropdownMenuItem>
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
  <div v-else class="text-gray-400 text-center p-5 italic">
    No images generated yet.
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { MediaItem, isVideo, useImageGeneration } from '@/assets/js/store/imageGeneration'
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

const props = defineProps<{
  mode: WorkflowModeType
}>()

const imageGeneration = useImageGeneration()

const nonQueuedImages = computed(() =>
  imageGeneration.generatedImages.filter(
    (i) => i.state !== 'queued' && i.mode === props.mode
  )
)

const dragImage = (item: MediaItem | null) => (event: DragEvent) => {
  if (!item) return
  event.preventDefault()
  const url = isVideo(item) ? item.videoUrl : item.imageUrl
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
  if (props.mode === 'imageGen')
    return imageGeneration.selectedGeneratedImageId === id
  if (props.mode === 'imageEdit')
    return imageGeneration.selectedEditedImageId === id
  if (props.mode === 'video')
    return imageGeneration.selectedVideoId === id
  return false
}

function selectImage(id: string) {
  if (props.mode === 'imageGen')
    imageGeneration.selectedGeneratedImageId = id
  else if (props.mode === 'imageEdit')
    imageGeneration.selectedEditedImageId = id
  else if (props.mode === 'video')
    imageGeneration.selectedVideoId = id
}
</script>

<style scoped>
</style>
