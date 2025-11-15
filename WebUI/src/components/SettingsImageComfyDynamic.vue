<template>
  <template v-for="input in imageGeneration.comfyInputs" :key="`${input.label}${input.nodeTitle}${input.nodeInput}`">
    <!-- Outpaint Canvas - special handling -->
    <div
      v-if="input.type === 'outpaintCanvas'"
      class="grid grid-cols-[120px_1fr] items-start gap-4"
    >
      <Label>
        {{ languages[getTranslationLabel('SETTINGS_IMAGE_COMFY_', input.label)] ?? input.label }}
      </Label>
      <SettingsOutpaintCanvas
        :image-url="imageUrl"
        :target-width="imageGeneration.width"
        :target-height="imageGeneration.height"
        :left="leftValue"
        :top="topValue"
        :right="rightValue"
        :bottom="bottomValue"
        :feathering="featheringValue"
        @update:left="(v) => updatePaddingValue('left', v)"
        @update:top="(v) => updatePaddingValue('top', v)"
        @update:right="(v) => updatePaddingValue('right', v)"
        @update:bottom="(v) => updatePaddingValue('bottom', v)"
        @update:feathering="(v) => updatePaddingValue('feathering', v)"
        @update:scaleBy="(v) => updateValue('ScaleImage', 'scale_by', v)"
        @update:cropWidth="(v) => updateValue('CropImage', 'width', v)"
        @update:cropHeight="(v) => updateValue('CropImage', 'height', v)"
        @update:cropX="(v) => updateValue('CropImage', 'x', v)"
        @update:cropY="(v) => updateValue('CropImage', 'y', v)"
      />
    </div>

    <!-- Regular inputs -->
    <div
      v-else
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
      <SettingsOutpaintDirection
        v-if="input.type === 'stringList' && input.nodeInput === 'direction'"
        :model-value="(input.current.value as 'top' | 'right' | 'bottom' | 'left')"
        @update:model-value="(value) => (input.current.value = value)"
      />
      <drop-down-new
        v-else-if="input.type === 'stringList'"
        :items="(input.options || []).map((opt) => ({ label: String(opt), value: String(opt), active: true }))"
        :value="String(input.current.value)"
        @change="(value) => (input.current.value = value)"
      />

      <!--    Boolean    -->
      <button
        v-if="input.type === 'boolean'"
        class="v-checkbox-control flex-none w-5 h-5"
        :class="{ 'v-checkbox-checked': input.current.value }"
        @click="() => (input.current.value = !input.current.value)"
      ></button>
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { Input } from './ui/aipgInput'
import { LoadImage } from '../components/ui/loadImage'
import { LoadVideo } from '../components/ui/loadVideo'
import { getTranslationLabel } from '@/lib/utils'
import DropDownNew from '@/components/DropDownNew.vue'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import Slider from './ui/slider/Slider.vue'
import { Label } from './ui/label'
import SettingsOutpaintDirection from './SettingsOutpaintDirection.vue'
import SettingsOutpaintCanvas from './SettingsOutpaintCanvas.vue'

const imageGeneration = useImageGenerationPresets()

// Find the image input to get the image URL
const imageInput = computed(() => {
  return imageGeneration.comfyInputs.find(
    (input) => input.type === 'image' && input.nodeTitle === 'Load Image' && input.nodeInput === 'image',
  )
})

const imageUrl = computed(() => {
  // Access the current value to make it reactive
  const url = (imageInput.value?.current.value as string) || ''
  console.log('Canvas imageUrl computed:', url ? url.substring(0, 50) + '...' : 'empty')
  return url
})

// Watch for changes to debug
watch(imageUrl, (newUrl) => {
  console.log('Canvas imageUrl changed:', newUrl ? newUrl.substring(0, 50) + '...' : 'empty')
})

// Find padding inputs
const findPaddingInput = (nodeInput: string) => {
  return imageGeneration.comfyInputs.find(
    (input) => input.nodeTitle === 'OutpaintDirection' && input.nodeInput === nodeInput,
  )
}

const leftValue = computed(() => {
  const input = findPaddingInput('left')
  return (input?.current.value as number) ?? 0
})

const topValue = computed(() => {
  const input = findPaddingInput('top')
  return (input?.current.value as number) ?? 0
})

const rightValue = computed(() => {
  const input = findPaddingInput('right')
  return (input?.current.value as number) ?? 0
})

const bottomValue = computed(() => {
  const input = findPaddingInput('bottom')
  return (input?.current.value as number) ?? 0
})

const featheringValue = computed(() => {
  const input = findPaddingInput('feathering')
  return (input?.current.value as number) ?? 24
})

function updatePaddingValue(nodeInput: string, value: number) {
  const input = findPaddingInput(nodeInput)
  if (input) {
    input.current.value = value
  }
}

function updateValue(nodeTitle: string, nodeInput: string, value: number) {
  const input = imageGeneration.comfyInputs.find(
    (input) => input.nodeTitle === nodeTitle && input.nodeInput === nodeInput,
  )
  if (input) {
    console.log(`Updating ${nodeTitle}.${nodeInput}: ${input.current.value} -> ${value}`)
    input.current.value = value
  } else {
    // Input might not be loaded yet, try again on next tick
    nextTick(() => {
      const retryInput = imageGeneration.comfyInputs.find(
        (input) => input.nodeTitle === nodeTitle && input.nodeInput === nodeInput,
      )
      if (retryInput) {
        console.log(`Updating ${nodeTitle}.${nodeInput} (retry): ${retryInput.current.value} -> ${value}`)
        retryInput.current.value = value
      } else {
        console.warn(`Input not found: ${nodeTitle}.${nodeInput} (available inputs: ${imageGeneration.comfyInputs.map(i => `${i.nodeTitle}.${i.nodeInput}`).join(', ')})`)
      }
    })
  }
}
</script>
