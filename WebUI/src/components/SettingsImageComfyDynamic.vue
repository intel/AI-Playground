<template>
  <template
    v-for="input in displayedComfyInputs"
    :key="`${input.label}${input.nodeTitle}${input.nodeInput}`"
  >
    <!-- Outpaint Canvas - button to open editor -->
    <div
      v-if="input.type === 'outpaintCanvas'"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label>
        {{ languages[getTranslationLabel('SETTINGS_IMAGE_COMFY_', input.label)] ?? input.label }}
      </Label>
      <Button variant="outline" @click="dialogStore.showMaskEditorDialog('outpaint')">
        Open Mask Editor
      </Button>
    </div>

    <!-- Inpaint Mask - button to open editor -->
    <div
      v-else-if="input.type === 'inpaintMask'"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label>
        {{ languages[getTranslationLabel('SETTINGS_IMAGE_COMFY_', input.label)] ?? input.label }}
      </Label>
      <Button variant="outline" @click="dialogStore.showMaskEditorDialog('inpaint')">
        Open Mask Editor
      </Button>
    </div>

    <!-- Regular inputs -->
    <div v-else class="grid grid-cols-[120px_1fr] items-center gap-4">
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
          :disabled="!isModifiable(input)"
        ></Slider>
        <span>{{ input.current.value }}</span>
      </div>

      <!--    Image (with preview support for inpaint/outpaint)    -->
      <LoadImageWithPreview
        v-if="input.type === 'image' && hasMaskEditing"
        :id="`${input.nodeTitle}.${input.nodeInput}`"
        :image-url-ref="input.current as WritableComputedRef<string>"
      ></LoadImageWithPreview>

      <!--    Image (standard)    -->
      <LoadImage
        v-else-if="input.type === 'image'"
        :id="`${input.nodeTitle}.${input.nodeInput}`"
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
        :disabled="!isModifiable(input)"
      ></Input>

      <drop-down-new
        v-else-if="input.type === 'stringList'"
        :items="
          (input.options || []).map((opt) => ({
            label: String(opt),
            value: String(opt),
            active: true,
          }))
        "
        :value="String(input.current.value)"
        :disabled="!isModifiable(input)"
        @change="(value) => (input.current.value = value)"
      />

      <!--    Boolean    -->
      <Checkbox
        v-if="input.type === 'boolean'"
        :model-value="Boolean(input.current.value)"
        :disabled="!isModifiable(input)"
        @update:model-value="
          (value: boolean | 'indeterminate') => (input.current.value = value === true)
        "
      />
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { Input } from './ui/aipgInput'
import { LoadImage, LoadImageWithPreview } from '../components/ui/loadImage'
import { LoadVideo } from '../components/ui/loadVideo'
import { getTranslationLabel } from '@/lib/utils'
import DropDownNew from '@/components/DropDownNew.vue'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { useDialogStore } from '@/assets/js/store/dialogs'
import { usePresets } from '@/assets/js/store/presets'
import Slider from './ui/slider/Slider.vue'
import { Label } from './ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'

const imageGeneration = useImageGenerationPresets()
const dialogStore = useDialogStore()
const presetsStore = usePresets()

// Clear preview state when preset changes
watch(
  () => presetsStore.activePresetName,
  () => {
    dialogStore.clearMaskEditorPreview()
  },
)

// Regenerate outpaint preview when resolution changes (and dialog is closed)
watch(
  [() => imageGeneration.width, () => imageGeneration.height],
  async ([newWidth, newHeight]) => {
    // Only regenerate if:
    // 1. There's an active outpaint preview
    // 2. The dialog is closed (when open, the canvas component handles updates)
    if (
      dialogStore.maskEditorMode !== 'outpaint' ||
      !dialogStore.maskEditorIsModified ||
      dialogStore.maskEditorDialogVisible
    ) {
      return
    }

    // Get the padding values from comfyInputs
    const findPaddingValue = (nodeInput: string): number => {
      const input = imageGeneration.comfyInputs.find(
        (input) => input.nodeTitle === 'OutpaintDirection' && input.nodeInput === nodeInput,
      )
      return (input?.current.value as number) ?? 0
    }

    const left = findPaddingValue('left')
    const top = findPaddingValue('top')
    const right = findPaddingValue('right')
    const bottom = findPaddingValue('bottom')

    await dialogStore.regenerateOutpaintPreview(newWidth, newHeight, left, top, right, bottom)
  },
)

// Filter inputs based on displayed attribute (default to true if not specified)
const displayedComfyInputs = computed(() => {
  return imageGeneration.comfyInputs.filter((input) => {
    // Default to true if displayed is not specified (backward compatibility)
    return input.displayed !== false
  })
})

// Helper to check if input is modifiable (default to true if not specified)
const isModifiable = (input: (typeof imageGeneration.comfyInputs)[0]) => {
  // Default to true if modifiable is not specified (backward compatibility)
  return input.modifiable !== false
}

// Check if current preset has mask editing (inpaint or outpaint)
const hasMaskEditing = computed(() => {
  return imageGeneration.comfyInputs.some(
    (input) => input.type === 'inpaintMask' || input.type === 'outpaintCanvas',
  )
})
</script>
