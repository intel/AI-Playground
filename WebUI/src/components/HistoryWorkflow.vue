<template>
  <div class="flex flex-col space-y-2 pr-3 h-full overflow-y-auto">
    <!--  "New image" entry -->
    <div
      v-if="showNewEntryPlaceholder"
      class="flex items-center gap-2 bg-accent rounded px-3 py-2 cursor-pointer relative border-2 transition-colors hover:bg-accent/80"
      :class="isSelected('new') ? 'border-primary' : 'border-transparent'"
      @click="selectImage('new')"
    >
      <div
        class="relative w-[150px] h-[90px] overflow-hidden rounded-sm flex items-center justify-center bg-background"
      >
        <span class="text-lg text-primary font-semibold">New Image</span>
      </div>
    </div>

    <!-- Generated Images, grouped by day -->
    <template v-if="imagesByDay.length > 0">
      <template v-for="imageGroup in imagesByDay" :key="imageGroup.dateKey">
        <details :open="isGroupInitiallyOpen(imageGroup.dateKey)" class="group/details">
          <summary
            class="flex flex-col gap-2 py-2 cursor-pointer hover:bg-muted/50 rounded transition-colors select-none list-none"
          >
            <div class="flex items-center gap-3">
              <ChevronDownIcon
                class="w-4 h-4 text-muted-foreground transition-transform group-open/details:-rotate-180 shrink-0"
              />
              <div class="h-px flex-1 bg-border"></div>
              <span class="text-sm text-foreground">
                {{ imageGroup.label }}
              </span>
              <div class="h-px flex-1 bg-border"></div>
            </div>
            <ThumbnailPreviewStrip
              class="group-open/details:hidden self-center"
              :items="imageGroup.images.filter((item) => item.type === 'image').reverse()"
            />
          </summary>

          <div class="flex flex-col space-y-2 h-full overflow-y-auto">
            <template v-for="image in imageGroup.images" :key="image.id">
              <div
                class="flex items-center gap-2 bg-muted rounded px-3 py-2 cursor-pointer relative border-2 transition-colors hover:bg-muted/80"
                :class="isSelected(image.id) ? 'border-primary' : 'border-transparent'"
                @click="selectImage(image.id)"
              >
                <div
                  class="relative w-[150px] h-[90px] overflow-hidden rounded-sm flex items-center justify-center bg-background"
                  draggable="true"
                  @dragstart="(e) => dragImage(image)(e)"
                >
                  <video
                    v-if="isVideo(image)"
                    :src="image.videoUrl"
                    class="w-full h-full object-cover"
                  />
                  <Model3DViewer
                    v-else-if="is3D(image)"
                    :src="image.model3dUrl"
                    class="w-full h-full"
                  />
                  <!-- Modern placeholder for queued/generating images without preview (exclude stopped) -->
                  <div
                              v-else-if="
                      image.type === 'image' &&
                      image.state !== 'stopped' &&
                      (image.state === 'queued' || image.state === 'generating') &&
                      !hasValidImageUrl(image)
                    "
                    class="w-full h-full flex items-center justify-center bg-gradient-to-br from-accent/20 to-muted/10"
                  >
                    <Spinner class="w-6 h-6 text-primary/50" />
                  </div>
                  <img
                    v-else-if="image.type === 'image' && hasValidImageUrl(image)"
                              :src="image.imageUrl"
                              class="w-full h-full object-cover"
                            />

                  <!-- Loading overlay for generating images (exclude stopped) -->
                  <div
                    v-if="
                      image.type === 'image' &&
                      image.state !== 'stopped' &&
                      (image.state === 'generating' || image.state === 'queued')
                    "
                    class="absolute inset-0 bg-background/40 backdrop-blur-[1px] flex items-center justify-center"
                  >
                    <Spinner class="w-5 h-5 text-primary" />
                  </div>

                  <!-- NSFW Blocked Overlay -->
                  <div
                    v-if="image.type === 'image' && nsfwBlockedImages.has(image.id)"
                    class="absolute inset-0 flex items-center justify-center bg-black/80"
                  >
                    <span class="text-white text-xs font-medium text-center px-1"
                      >NSFW Blocked</span
                    >
                  </div>

                  <div
                    v-else-if="image.type === 'image' && image.fromImageGen"
                    class="absolute bottom-0 w-full bg-background/60 text-foreground text-[14px] text-center py-[2px]"
                  >
                    {{ languages.ENHANCE_PREVIEW_BEFORE_PROCESS }}
                  </div>
                </div>

                <!-- Prompt and date display -->
                <div class="flex flex-col flex-1 min-w-0 gap-1">
                  <span
                    v-if="image.settings.prompt"
                    class="text-sm text-foreground truncate"
                    :title="image.settings.prompt"
                  >
                    {{ truncatePrompt(image.settings.prompt) }}
                  </span>
                  <span v-if="image.createdAt" class="text-xs text-muted-foreground truncate">
                    {{ formatPresetName(image.settings.preset, image.settings.variant) }}
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
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <DropdownMenuItem @select="(e: Event) => e.preventDefault()">
                            Remove
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
                              {{ languages.COM_REMOVE }}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </template>
          </div>
        </details>
      </template>
    </template>
    <div v-else class="text-muted-foreground text-center p-5 italic">No images generated yet.</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDownIcon } from '@heroicons/vue/24/outline'
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
import ThumbnailPreviewStrip from './ThumbnailPreviewStrip.vue'
import { checkIfNsfwBlocked } from '@/lib/utils'
import { Spinner } from '@/components/ui/spinner'

const props = defineProps<{
  mode: WorkflowModeType
}>()

const imageGeneration = useImageGenerationPresets()

// Track which images are NSFW blocked
const nsfwBlockedImages = ref<Set<string>>(new Set())

// Check if imageUrl is the transparent placeholder
const isPlaceholderUrl = (url: string | undefined): boolean => {
  if (!url || url.trim() === '') return true
  const placeholderUrl =
    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"%3E%3C/svg%3E'
  return url === placeholderUrl
}

const hasValidImageUrl = (image: MediaItem): boolean => {
  if (image.type !== 'image') return false
  return !isPlaceholderUrl(image.imageUrl)
}

const nonQueuedImages = computed(() =>
  imageGeneration.generatedImages
    .filter((i) => i.state !== 'queued' && i.mode === props.mode)
    .reverse(),
)

const imagesByDay = computed(() => {
  const groups = new Map<string, { label: string; images: MediaItem[] }>()

  const imagesNewestFirst = [...nonQueuedImages.value].sort((a, b) => {
    const getSortDate = (item: MediaItem) => {
      return (item.createdAt ?? item.state === 'generating') ? Date.now() : 0
    }
    return getSortDate(b) - getSortDate(a)
  })

  for (const image of imagesNewestFirst) {
    const dateKey = new Date(image.createdAt ?? Date.now()).toDateString()
    const label = getDayLabel(image.createdAt)

    if (!groups.has(dateKey)) {
      groups.set(dateKey, { label, images: [] })
    }
    groups.get(dateKey)!.images.push(image)
  }

  return Array.from(groups.entries()).map(([dateKey, value]) => ({
    dateKey,
    label: value.label,
    images: value.images,
  }))
})

function formatPresetName(preset?: string, variant?: string): string {
  if (!preset) return ''
  return variant ? `${preset} - ${variant}` : preset
}

function getDayLabel(timestamp?: number): string {
  const date = new Date(timestamp ?? Date.now())
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function truncatePrompt(prompt: string, maxLength: number = 50): string {
  if (prompt.length <= maxLength) return prompt
  return prompt.substring(0, maxLength) + '...'
}

function isGroupInitiallyOpen(dateKey: string): boolean {
  const today = new Date().toDateString()
  return dateKey === today
}

// Check new images for NSFW blocking
watch(
  nonQueuedImages,
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

const showNewEntryPlaceholder = computed(() => {
  if (props.mode !== 'imageGen') return false
  if (nonQueuedImages.value.length === 0) return true
  return (
    imageGeneration.selectedGeneratedImageId === null ||
    imageGeneration.selectedGeneratedImageId === 'new'
  )
})

function deleteImage(image: MediaItem) {
  console.log('Deleting image:', image.id)
  imageGeneration.deleteImage(image.id)
}

function isSelected(id: string) {
  if (props.mode === 'imageGen') {
    if (id === 'new') {
      return (
        imageGeneration.selectedGeneratedImageId === null ||
        imageGeneration.selectedGeneratedImageId === 'new'
      )
    }
    return imageGeneration.selectedGeneratedImageId === id
  }
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
