<template>
  <div class="flex flex-col gap-2">
    <div ref="videoDropZone" class="flex justify-center relative">
      <div
        v-show="isOverDropZone"
        class="bg-background/70 absolute inset-0 flex items-center justify-center text-foreground text-lg z-10"
      >
        {{ languages.COM_LOAD_VIDEO }}
      </div>
      <div
        v-if="!hasVideo"
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
            d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
        <p class="text-sm text-muted-foreground text-center px-4">
          {{ languages.COM_LOAD_VIDEO }}
        </p>
      </div>
      <video
        v-else
        :src="videoUrlRef.value as string"
        alt="Video"
        class="w-64 py-4 object-scale-down"
        controls
        controlsList="nodownload nofullscreen noremoteplayback"
      />
    </div>
    <div class="flex justify-center">
      <input
        :id="id"
        :accept="acceptedVideoTypes.join(',')"
        type="file"
        class="hidden"
        v-on:change="(e: Event) => handleFilesEvent(videoUrlRef as Ref<string, string>)(e)"
      />
      <label
        :for="id"
        :class="
          cn(
            'text-base bg-primary py-1 px-6 rounded-sm hover:opacity-90 hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ',
            props.class,
          )
        "
        >{{ languages.COM_LOAD_VIDEO }}</label
      >
    </div>
  </div>
</template>

<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import { useDropZone } from '@vueuse/core'

const props = defineProps<{
  videoUrlRef: WritableComputedRef<string>
  defaultValue?: string | number
  modelValue?: string | number
  class?: HTMLAttributes['class']
  id: string
}>()

const acceptedVideoTypes = ['video/mp4', 'video/h264', 'video/h265']

const hasVideo = computed(() => {
  const value = props.videoUrlRef.value
  return (
    value &&
    typeof value === 'string' &&
    value !== '' &&
    value.match(/^data:video\/(mp4|h264|h265);base64,/)
  )
})

const videoDropZone = useTemplateRef('videoDropZone')

const { isOverDropZone } = useDropZone(videoDropZone, {
  onDrop: (files) => processFiles(files, props.videoUrlRef),
  dataTypes: acceptedVideoTypes,
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

    if (!file.type.startsWith('video/')) {
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
    }
    reader.readAsDataURL(file)
  }
}
</script>
