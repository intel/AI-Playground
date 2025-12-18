<template>
  <div class="flex flex-col gap-2">
    <div ref="imgDropZone" class="flex justify-center relative">
      <div
        v-show="isOverDropZone"
        class="bg-background/70 absolute inset-0 flex items-center justify-center text-foreground text-lg z-10"
      >
        {{ languages.COM_LOAD_IMAGE }}
      </div>
      <div
        v-if="!hasImage"
        class="w-64 h-64 flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg bg-muted/30"
      >
        <svg
          class="w-16 h-16 text-muted-foreground mb-2"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <p class="text-sm text-muted-foreground text-center px-4">
          {{ languages.COM_LOAD_IMAGE }}
        </p>
      </div>
      <img v-else :src="displayImageUrl" alt="Image" class="w-64 py-4 object-scale-down" />
    </div>
    <!-- Show Original hint with tooltip -->
    <div v-if="hasImage && dialogStore.maskEditorIsModified" class="flex justify-center">
      <TooltipProvider>
        <Tooltip :delay-duration="0">
          <TooltipTrigger as-child>
            <span
              class="text-xs text-muted-foreground cursor-help hover:text-foreground transition-colors"
            >
              Hover to show original
            </span>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            :side-offset="8"
            class="p-2 bg-card border border-border shadow-lg max-w-xs"
          >
            <img
              v-if="dialogStore.maskEditorOriginalImageUrl"
              :src="dialogStore.maskEditorOriginalImageUrl"
              alt="Original image"
              class="max-w-[256px] max-h-[256px] object-contain rounded"
            />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
    <div class="flex justify-center">
      <input
        :id="id"
        :accept="acceptedImageTypes.join(',')"
        type="file"
        class="hidden"
        v-on:change="(e: Event) => handleFilesEvent(imageUrlRef as Ref<string, string>)(e)"
      />
      <label
        :for="id"
        :class="
          cn(
            'text-base bg-primary py-1 px-6 rounded-sm hover:opacity-90 hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ',
            props.class,
          )
        "
        >{{ languages.COM_LOAD_IMAGE }}</label
      >
    </div>
  </div>
</template>

<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import { useDropZone } from '@vueuse/core'
import { useDialogStore } from '@/assets/js/store/dialogs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const props = defineProps<{
  imageUrlRef: WritableComputedRef<string>
  defaultValue?: string | number
  modelValue?: string | number
  class?: HTMLAttributes['class']
  id: string
}>()

const dialogStore = useDialogStore()

const acceptedImageTypes = ['image/jpeg', 'image/png', 'image/webp']

const hasImage = computed(() => {
  const value = props.imageUrlRef.value
  return (
    value &&
    typeof value === 'string' &&
    value !== '' &&
    value.match(/^data:image\/(png|jpeg|webp);base64,/)
  )
})

// Determine which image URL to display (always show preview if modified)
const displayImageUrl = computed(() => {
  // If we have a preview image, show it
  if (dialogStore.maskEditorIsModified && dialogStore.maskEditorPreviewImageUrl) {
    return dialogStore.maskEditorPreviewImageUrl
  }

  // Otherwise show the actual image URL
  return props.imageUrlRef.value as string
})

const imgDropZone = useTemplateRef('imgDropZone')

const { isOverDropZone } = useDropZone(imgDropZone, {
  onDrop: (files) => processFiles(files, props.imageUrlRef),
  dataTypes: acceptedImageTypes,
  multiple: false,
  preventDefaultForUnhandled: false,
})

const handleFilesEvent = (inputCurrent: Ref<string, string>) => (event: Event) => {
  if (!event.target || !(event.target instanceof HTMLInputElement) || !event.target.files) {
    return
  }
  const files = event.target.files
  processFiles([...files], inputCurrent)
}

function processFiles(files: File[] | null, inputCurrent: Ref<string, string>) {
  if (!files) {
    return
  }
  for (let i = 0; i < files.length; i++) {
    const file = files[i]

    if (!file.type.startsWith('image/')) {
      continue
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      if (
        !e.target ||
        !(e.target instanceof FileReader) ||
        !e.target.result ||
        typeof e.target.result !== 'string'
      ) {
        console.error('Failed to read file')
        return
      }
      inputCurrent.value = e.target.result
      // Clear preview when a new image is loaded
      dialogStore.clearMaskEditorPreview()
    }
    reader.readAsDataURL(file)
  }
}
</script>
