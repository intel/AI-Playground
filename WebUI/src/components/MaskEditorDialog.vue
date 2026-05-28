<template>
  <div v-if="dialogStore.maskEditorDialogVisible" class="dialog-container z-10">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/55 flex justify-center items-center"
    >
      <div
        class="py-8 px-8 min-w-[800px] max-w-[90vw] max-h-[90vh] flex flex-col bg-card rounded-3xl gap-6 text-foreground overflow-auto"
        :class="{ 'animate-scale-in': animate }"
      >
        <!-- Header -->
        <div class="flex items-center justify-between">
          <h2 class="text-xl font-semibold">
            {{ dialogStore.maskEditorMode === 'outpaint' ? 'Outpaint Canvas' : 'Inpaint Mask' }}
          </h2>
          <button
            class="p-2 rounded hover:bg-muted transition-colors"
            @click="dialogStore.closeMaskEditorDialog"
          >
            <XMarkIcon class="size-5" />
          </button>
        </div>

        <!-- Editor Content -->
        <div class="flex-1 min-h-0">
          <!-- Outpaint Canvas Editor -->
          <SettingsOutpaintCanvas
            v-if="dialogStore.maskEditorMode === 'outpaint'"
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
            @update:preview="handlePreviewUpdate"
            @composite-export="handleOutpaintCompositeExport"
          />

          <!-- Inpaint Mask Editor -->
          <SettingsInpaintMask
            v-else-if="dialogStore.maskEditorMode === 'inpaint'"
            :image-url="dialogStore.maskEditorOriginalImageUrl || imageUrl"
            :masked-image-url="maskedImageUrl"
            @update:image="updateMaskImage"
            @update:preview="handlePreviewUpdate"
          />
        </div>

        <!-- Footer -->
        <div class="flex justify-end gap-4">
          <button
            class="bg-primary text-primary-foreground py-2 px-6 rounded hover:bg-primary/90 transition-colors"
            @click="dialogStore.closeMaskEditorDialog"
          >
            {{ i18nState.COM_DONE }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { XMarkIcon } from '@heroicons/vue/24/outline'
import { useDialogStore } from '@/assets/js/store/dialogs'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { saveImageToMediaInput } from '@/lib/utils'
import { useI18N } from '@/assets/js/store/i18n'
import SettingsOutpaintCanvas from './SettingsOutpaintCanvas.vue'
import SettingsInpaintMask from './SettingsInpaintMask.vue'

const dialogStore = useDialogStore()
const imageGeneration = useImageGenerationPresets()
const i18nState = useI18N().state

const animate = ref(false)

// Animation on dialog open and store original image URL
watch(
  () => dialogStore.maskEditorDialogVisible,
  (isVisible) => {
    if (isVisible) {
      nextTick(() => {
        animate.value = true
      })
      setTimeout(() => {
        animate.value = false
      }, 300)

      // Store the original image URL when dialog opens
      if (imageUrl.value && !dialogStore.maskEditorOriginalImageUrl) {
        dialogStore.setMaskEditorOriginalImage(imageUrl.value)
      }
    }
  },
)

// Find the image input to get the image URL
const imageInput = computed(() => {
  return imageGeneration.comfyInputs.find(
    (input) =>
      input.type === 'image' && input.nodeTitle === 'Load Image' && input.nodeInput === 'image',
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

const leftValue = computed(() => {
  const input = findPaddingInput('left')
  if (input?.current) {
    const value = input.current.value
    return (value as number) ?? 0
  }
  return 0
})

const topValue = computed(() => {
  const input = findPaddingInput('top')
  if (input?.current) {
    const value = input.current.value
    return (value as number) ?? 0
  }
  return 0
})

const rightValue = computed(() => {
  const input = findPaddingInput('right')
  if (input?.current) {
    const value = input.current.value
    return (value as number) ?? 0
  }
  return 0
})

const bottomValue = computed(() => {
  const input = findPaddingInput('bottom')
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

// Find the inpaint mask input
const inpaintMaskInput = computed(() => {
  return imageGeneration.comfyInputs.find((input) => input.type === 'inpaintMask')
})

// Get the masked image URL (existing mask with alpha channel)
const maskedImageUrl = computed(() => {
  return (inpaintMaskInput.value?.current.value as string) || ''
})

// Convert data URI emits to durable `aipg-media://` URLs before assigning to
// `input.current.value`. Two reasons:
// 1. `comfyUiPresets.queueBatch` snapshots `current.value` into each queued
//    `MediaItem.dynamicSettings[].current`. With full-res PNG data URIs there,
//    pinia-plugin-persistedstate quickly blows the localStorage quota.
// 2. The persist serializer strips `data:image/` values from
//    `comfyInputsPerPreset`, so on reload/HMR the input would lose its value
//    and `validateRequiredImageInputs` would report a missing required input.
// Saving to `media/input/` yields a short, persistable URL that
// `modifyDynamicSettingsInWorkflow` already knows how to upload via
// `imageUrlToDataUri`.
async function persistAsAipgMedia(value: string): Promise<string> {
  if (!value.startsWith('data:image/')) return value
  return await saveImageToMediaInput(value)
}

async function updateMaskImage(value: string) {
  const initialInput = inpaintMaskInput.value
  let persisted: string
  try {
    persisted = await persistAsAipgMedia(value)
  } catch (e) {
    console.error('Failed to persist inpaint mask as aipg-media URL', e)
    return
  }
  // Race-safety: drop the write if the dialog/preset switched the input out
  // from under us. The next emit will supersede in the new context.
  if (inpaintMaskInput.value !== initialInput) return
  const input = inpaintMaskInput.value
  if (input && input.current) {
    input.current.value = persisted
  } else {
    nextTick(() => {
      const retryInput = imageGeneration.comfyInputs.find((i) => i.type === 'inpaintMask')
      if (retryInput && retryInput.current) {
        retryInput.current.value = persisted
      }
    })
  }
}

function handlePreviewUpdate(previewUrl: string) {
  // Store the original image URL if not already stored
  if (!dialogStore.maskEditorOriginalImageUrl && imageUrl.value) {
    dialogStore.setMaskEditorOriginalImage(imageUrl.value)
  }
  // Update the preview
  dialogStore.setMaskEditorPreview(previewUrl)
}

async function handleOutpaintCompositeExport(dataUri: string) {
  const initialInput = imageGeneration.comfyInputs.find((i) => i.type === 'outpaintCanvas')
  let persisted: string
  try {
    persisted = await persistAsAipgMedia(dataUri)
  } catch (e) {
    console.error('Failed to persist outpaint composite as aipg-media URL', e)
    return
  }
  const currentInput = imageGeneration.comfyInputs.find((i) => i.type === 'outpaintCanvas')
  // Race-safety: skip if preset/input changed during the await; the next
  // emit will overwrite in the new context.
  if (currentInput !== initialInput) return
  if (currentInput?.current) {
    currentInput.current.value = persisted
  } else {
    nextTick(() => {
      const retry = imageGeneration.comfyInputs.find((i) => i.type === 'outpaintCanvas')
      if (retry?.current) retry.current.value = persisted
    })
  }
}
</script>
