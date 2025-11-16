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
  return (imageInput.value?.current.value as string) || ''
})

// Find padding inputs
const findPaddingInput = (nodeInput: string) => {
  return imageGeneration.comfyInputs.find(
    (input) => input.nodeTitle === 'OutpaintDirection' && input.nodeInput === nodeInput,
  )
}

// Use toRef to ensure reactivity when inputs change
const leftInput = computed(() => findPaddingInput('left'))
const topInput = computed(() => findPaddingInput('top'))
const rightInput = computed(() => findPaddingInput('right'))
const bottomInput = computed(() => findPaddingInput('bottom'))

const leftValue = computed(() => {
  const input = leftInput.value
  if (input?.current) {
    // Access the value to track reactivity
    const value = input.current.value
    return (value as number) ?? 0
  }
  return 0
})

const topValue = computed(() => {
  const input = topInput.value
  if (input?.current) {
    const value = input.current.value
    return (value as number) ?? 0
  }
  return 0
})

const rightValue = computed(() => {
  const input = rightInput.value
  if (input?.current) {
    const value = input.current.value
    return (value as number) ?? 0
  }
  return 0
})

const bottomValue = computed(() => {
  const input = bottomInput.value
  if (input?.current) {
    const value = input.current.value
    return (value as number) ?? 0
  }
  return 0
})

const featheringValue = computed(() => {
  const input = findPaddingInput('feathering')
  return (input?.current.value as number) ?? 24
})

function updatePaddingValue(nodeInput: string, value: number) {
  const input = findPaddingInput(nodeInput)
  if (input && input.current) {
    input.current.value = value
  } else {
    // Input might not be loaded yet, try again on next tick
    nextTick(() => {
      const retryInput = findPaddingInput(nodeInput)
      if (retryInput && retryInput.current) {
        retryInput.current.value = value
      }
    })
  }
}

function updateValue(nodeTitle: string, nodeInput: string, value: number) {
  const input = imageGeneration.comfyInputs.find(
    (input) => input.nodeTitle === nodeTitle && input.nodeInput === nodeInput,
  )
  if (input) {
    input.current.value = value
  } else {
    // Input might not be loaded yet, try again on next tick
    nextTick(() => {
      const retryInput = imageGeneration.comfyInputs.find(
        (input) => input.nodeTitle === nodeTitle && input.nodeInput === nodeInput,
      )
      if (retryInput) {
        retryInput.current.value = value
      }
    })
  }
}
</script>
