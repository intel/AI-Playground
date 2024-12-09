<template>
    <div v-for="input, i in imageGeneration.comfyInputs" class="flex flex-col gap-2">
        <p>{{ input.label }}</p>

        <!--    Number    -->
        <slide-bar v-if="input.type === 'number'" v-model:current="input.current.value" :min="input.min"
            :max="input.max" :step="input.step"></slide-bar>

        <!--    Image    -->
        <img ref="imgDropZones" v-if="input.type === 'image'" :src="input.current.value" alt="Image" class="w-64 h-64 object-scale-down self-center"></img>
        <Input v-if="input.type === 'image'" accept="image/jpeg,image/png,image/webp" id="picture" type="file"
            v-on:change="(e) => handleFilesEvent(input.current)(e)"></Input>

        <!--    String    -->
        <Input v-if="input.type === 'string'" type="text" v-model="input.current.value"></Input>

        <!--    Boolean    -->
        <button v-if="input.type === 'boolean'" class="v-checkbox-control flex-none w-5 h-5"
                :class="{ 'v-checkbox-checked': input.current.value }"
                @click="() => input.current.value = !input.current.value">
        </button>
    </div>
</template>

<script setup lang="ts">
import { useImageGeneration } from "@/assets/js/store/imageGeneration";
import { Input } from '../components/ui/input'
import SlideBar from "../components/SlideBar.vue";
import { useDropZone } from '@vueuse/core';

const imageGeneration = useImageGeneration();
const imgDropZones = useTemplateRef('imgDropZones')

const { isOverDropZone } = useDropZone(imgDropZones.value, {
  onDrop: (e) => console.log('Dropped!', e),
  // specify the types of data to be received.
  dataTypes: ['image/jpeg'],
  // control multi-file drop
  multiple: true,
  // whether to prevent default behavior for unhandled events
  preventDefaultForUnhandled: false,
})

onMounted(() => console.log('imgDropZones', imgDropZones.value))

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