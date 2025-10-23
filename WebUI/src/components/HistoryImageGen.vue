<template>
  <div
    v-show="nonQueuedImages.length > 0"
    class="flex flex-col space-y-2 p-4 bg-neutral-900 h-full overflow-y-auto"
  >
    <div
      v-for="image in nonQueuedImages"
      :key="image.id"
      class="flex items-center gap-2 bg-gray-700 rounded p-1 cursor-pointer relative border-2 transition-colors hover:bg-gray-600"
      :class="imageGeneration.selectedGeneratedImageId === image.id ? 'border-blue-500' : 'border-transparent'"
      @click="imageGeneration.selectedGeneratedImageId = image.id"
    >
      <div
        class="w-[100px] h-[60px] overflow-hidden rounded-sm flex items-center justify-center bg-black"
        draggable="true"
        @dragstart="(e) => dragImage(image)(e)"
      >
        <video v-if="isVideo(image)" :src="image.videoUrl" class="w-full h-full object-cover" />
        <img v-else :src="image.imageUrl" class="w-full h-full object-cover" />
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
                  <AlertDialogTitle>Delete image?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently remove this image.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction @click="() => deleteImage(image)">
                    Delete
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
import { useI18N } from '@/assets/js/store/i18n'
import * as toast from '@/assets/js/toast'
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

const imageGeneration = useImageGeneration()
const i18nState = useI18N().state

const nonQueuedImages = computed(() =>
  imageGeneration.generatedImages.filter((i) => i.state !== 'queued')
)

const dragImage = (item: MediaItem | null) => (event: DragEvent) => {
  if (!item) return
  event.preventDefault()
  const url = isVideo(item) ? item.videoUrl : item.imageUrl
  window.electronAPI.startDrag(url)
}

function reloadImage(image: MediaItem) {
  console.log('Reloading image:', image.id)
  toast.info(`Reloading image ${image.id}... (dummy)`)
}

function deleteImage(image: MediaItem) {
  console.log('Deleting image:', image.id)
  imageGeneration.deleteImage(image.id)
  toast.success(i18nState.COM_DELETE_SUCCESS_TIP || 'Image deleted.')
}
</script>

<style scoped>
</style>
