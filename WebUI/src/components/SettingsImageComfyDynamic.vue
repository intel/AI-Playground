<template>
  <div
    v-for="input in imageGeneration.comfyInputs"
    :key="`${input.label}${input.nodeTitle}${input.nodeInput}`"
    class="grid grid-cols-[120px_1fr] items-center gap-4"
  >
    <Label>
      {{ languages[getTranslationLabel('SETTINGS_IMAGE_COMFY_', input.label)] ?? input.label }}
    </Label>

    <!--    Number    -->
    <div v-if="input.type === 'number'" class="flex gap-2">
      <Slider
        v-model="input.current.value as number"
        :min="input.min"
        :max="input.max"
        :step="input.step"
      ></Slider>
      <span>{{ input.current.value }}</span>
    </div>

    <!--    Image    -->
    <LoadImage
      :id="`${input.nodeTitle}.${input.nodeInput}`"
      v-if="input.type === 'image'"
      :image-url-ref="input.current as WritableComputedRef<string>"
    ></LoadImage>

    <!--    Video    -->
    <LoadVideo
      :id="`${input.nodeTitle}.${input.nodeInput}`"
      v-if="input.type === 'video'"
      :video-url-ref="input.current as WritableComputedRef<string>"
    ></LoadVideo>

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
          <span class="rounded-full bg-primary w-2 h-2"></span>
          <span>{{ input.current.value as string }}</span>
        </div>
      </template>
      <template #list="slotItem">
        <div class="flex gap-2 items-center">
          <span class="rounded-full bg-primary w-2 h-2"></span>
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
import { Input } from './ui/aipgInput'
import { LoadImage } from '../components/ui/loadImage'
import { LoadVideo } from '../components/ui/loadVideo'
import { getTranslationLabel } from '@/lib/utils'
import DropSelector from '@/components/DropSelector.vue'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import Slider from './ui/slider/Slider.vue'
import { Label } from './ui/label'

const imageGeneration = useImageGenerationPresets()
</script>
