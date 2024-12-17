<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { useDropZone } from '@vueuse/core';

const props = defineProps<{
  imageUrlRef: WritableComputedRef<string>
  defaultValue?: string | number
  modelValue?: string | number
  class?: HTMLAttributes['class']
  id: string
}>()

const acceptedImageTypes = ['image/jpeg', 'image/png', 'image/webp']

const imgDropZone = useTemplateRef('imgDropZone')

const { isOverDropZone } = useDropZone(imgDropZone, {
  onDrop: (files) => processFiles(files, props.imageUrlRef),
  dataTypes: acceptedImageTypes,
  multiple: false,
  preventDefaultForUnhandled: false,
})

const handleFilesEvent = (inputCurrent: Ref<string, string>) => (event: Event) => {
    if (!event.target || !(event.target instanceof HTMLInputElement) || !event.target.files) {
        return;
    }
    const files = event.target.files;
    processFiles([...files], inputCurrent);
}

function processFiles(files: File[] | null, inputCurrent: Ref<string, string>) {
    if (!files) {
        return;
    }
    for (let i = 0; i < files.length; i++) {
        const file = files[i];

        if (!file.type.startsWith("image/")) {
            continue;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            if (!e.target || !(e.target instanceof FileReader) || !e.target.result || typeof e.target.result !== "string") {
                console.error("Failed to read file");
                return;
            }
            inputCurrent.value = e.target.result;
        };
        reader.readAsDataURL(file);
    }
}
</script>

<template>
  <div ref="imgDropZone" class="flex justify-center relative">
    <div v-show="isOverDropZone" class="bg-black/70 absolute inset-0 flex items-center justify-center text-white text-lg">Load Image</div>
    <img :src="(imageUrlRef.value as string)" alt="Image" class="w-64 py-4 object-scale-down"></img>
  </div>
  <div class="flex justify-center">
    <input :id="id" :accept="acceptedImageTypes.join(',')" type="file" class="hidden"
    v-on:change="(e: Event) => handleFilesEvent(imageUrlRef as Ref<string, string>)(e)"
    >
    <label :for="id" :class="cn('text-base bg-color-active py-1 px-6 rounded hover:opacity-90 hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ', props.class)">Load Image</label>
  </div>
    
</template>
