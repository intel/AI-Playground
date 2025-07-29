<template>
  <div ref="videoDropZone" class="flex justify-center relative">
    <div
      v-show="isOverDropZone"
      class="bg-black/70 absolute inset-0 flex items-center justify-center text-white text-lg"
    >
      {{ languages.COM_LOAD_VIDEO }}
    </div>
    <video :src="videoUrlRef.value as string" alt="Video" class="w-64 py-4 object-scale-down" controls
              controlsList="nodownload nofullscreen noremoteplayback"/>
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
          'text-base bg-color-active py-1 px-6 rounded-sm hover:opacity-90 hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ',
          props.class,
        )
      "
      >{{ languages.COM_LOAD_VIDEO }}</label
    >
  </div>
</template>

<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
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
