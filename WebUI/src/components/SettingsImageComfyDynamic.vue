<template>
  <div
    v-for="input in imageGeneration.comfyInputs"
    :key="`${input.nodeTitle}${input.nodeInput}`"
    class="flex flex-col gap-2 py-2"
  >
    <p>
      {{ languages[getTranslationLabel('SETTINGS_IMAGE_COMFY_', input.label)] ?? input.label }}
    </p>

    <!--    Number    -->
    <slide-bar
      v-if="input.type === 'number'"
      v-model:current="input.current.value as number"
      :min="input.min"
      :max="input.max"
      :step="input.step"
    ></slide-bar>

    <!--    Image    -->
    <LoadImage
      :id="`${input.nodeTitle}.${input.nodeInput}`"
      v-if="input.type === 'image'"
      :image-url-ref="input.current as WritableComputedRef<string>"
    ></LoadImage>

    <!--    String    -->
    <Input
      v-if="input.type === 'string'"
      type="text"
      v-model="input.current.value as string"
    ></Input>

    <!--    StringList    -->
    <drop-selector
      v-if="input.type === 'stringList'"
      :array="input.options"
      @change="(stringItem) => (input.current.value = stringItem)"
    >
      <template #selected>
        <div class="flex gap-2 items-center">
          <span class="rounded-full bg-green-500 w-2 h-2"></span>
          <span>{{ input.current.value as string }}</span>
        </div>
      </template>
      <template #list="slotItem">
        <div class="flex gap-2 items-center">
          <span class="rounded-full bg-green-500 w-2 h-2"></span>
          <span>{{ slotItem.item }}</span>
        </div>
      </template>
    </drop-selector>

    <!--    Boolean    -->
    <button
      v-if="input.type === 'boolean'"
      class="v-checkbox-control flex-none w-5 h-5"
      :class="{ 'v-checkbox-checked': input.current.value }"
      @click="() => (input.current.value = !input.current.value)"
    ></button>
  </div>
</template>

<script setup lang="ts">
import { useImageGeneration } from '@/assets/js/store/imageGeneration'
import { Input } from './ui/aipgInput'
import { LoadImage } from '../components/ui/loadImage'
import SlideBar from '../components/SlideBar.vue'
import { getTranslationLabel } from '@/lib/utils'
import DropSelector from '@/components/DropSelector.vue'

const imageGeneration = useImageGeneration()
</script>
