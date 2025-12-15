<template>
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Megapixels</Label>
      <drop-down-new
        :title="'Megapixels'"
        :value="megaPixelsIndex.toString()"
        :items="megaPixelsDropdownItems"
        @change="
          (value) => {
            megaPixelsIndex = parseInt(value)
          }
        "
      />
    </div>

    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Resolution</Label>
      <div class="flex gap-2 items-center">
        <input
          v-model.number="widthInput"
          type="number"
          min="1"
          class="w-full rounded-lg bg-input border border-border text-foreground py-1 px-2 text-center focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          :disabled="props.disabled"
        />
        <span class="text-muted-foreground">×</span>
        <input
          v-model.number="heightInput"
          type="number"
          min="1"
          class="w-full rounded-lg bg-input border border-border text-foreground py-1 px-2 text-center focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          :disabled="props.disabled"
        />
      </div>
    </div>

    <div class="grid grid-cols-[120px_1fr] items-end gap-4">
      <Label class="whitespace-nowrap">Aspect Ratio</Label>
      <div class="flex flex-row justify-between items-stretch">
        <div
          v-for="(res, i) in resolutionsPerMegaPixelsOption[megaPixelsIndex]"
          :key="`res-${i}`"
          @click="
            () => {
              if (!props.disabled) resolutionIndex = i
            }
          "
          :className="
            clsx('flex flex-col items-center justify-end gap-1 transition-colors', {
              'cursor-pointer': !props.disabled,
            })
          "
        >
          <div
            :className="
              clsx('transition-colors', {
                'bg-background border-2': i % 2 === 0,
                'border-border': (resolutionIndex !== i || disabled) && i % 2 === 0,
                'border-primary': resolutionIndex === i && !disabled && i % 2 === 0,
              })
            "
            :style="
              (() => {
                const aspectRatio =
                  aspectRatios.find((ar) => ar.label === res.aspectRatio)?.value ?? 1
                const area = 600
                const width = Math.sqrt(area * aspectRatio)
                const height = area / width
                return {
                  width: `${width.toFixed(0)}px`,
                  height: `${height.toFixed(0)}px`,
                }
              })()
            "
          ></div>
          <span
            :className="
              clsx('text-xs select-none transition-colors', {
                'text-muted-foreground': resolutionIndex !== i || disabled,
                'text-primary font-semibold': resolutionIndex === i && !disabled,
              })
            "
          >
            {{ res.aspectRatio }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type SliderRootProps } from 'radix-vue'
import { clsx } from 'clsx'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import {
  DEFAULT_RESOLUTION_CONFIG,
  parseAspectRatio,
  computeResolution,
} from '@/assets/js/store/imageGenerationUtils'
import type { ComfyUiPreset } from '@/assets/js/store/presets'
import { Label } from '@/components/ui/label'
import DropDownNew from '@/components/DropDownNew.vue'

const props = defineProps<SliderRootProps & { class?: string }>()

const imageGeneration = useImageGenerationPresets()

// Get resolution configuration from active preset or use default
const resolutionConfig = computed(() => {
  const preset = imageGeneration.activePreset as ComfyUiPreset | null
  if (preset?.resolutionConfig) {
    return preset.resolutionConfig
  }
  // Fallback to default SDXL config for backward compatibility
  return DEFAULT_RESOLUTION_CONFIG
})

// Aspect ratios with computed numeric values from config
const aspectRatios = computed(() =>
  resolutionConfig.value.aspectRatios.map((label) => ({
    label,
    value: parseAspectRatio(label),
  })),
)

// Megapixel options from config
const megaPixelsOptions = computed(() => resolutionConfig.value.megapixels)

const megaPixelsDropdownItems = computed(() =>
  megaPixelsOptions.value.map((option, index) => ({
    label: `${option.label} MP`,
    value: index.toString(),
    active: index === megaPixelsIndex.value,
  })),
)

// Compute all resolution combinations from config
const resolutionsPerMegaPixelsOption = computed(() => {
  const useLookup = resolutionConfig.value.useLookupTable !== false
  return megaPixelsOptions.value.map((megaPixels) =>
    aspectRatios.value.map((aspectRatio) => ({
      aspectRatio: aspectRatio.label,
      ...computeResolution(megaPixels, aspectRatio.label, useLookup),
    })),
  )
})

const megaPixelsIndex = computed({
  get: () => {
    const currentTotalPixels = imageGeneration.width * imageGeneration.height
    const bestMatch = megaPixelsOptions.value
      .map((option) => ({ ...option, distance: Math.abs(option.totalPixels - currentTotalPixels) }))
      .sort((a, b) => a.distance - b.distance)[0]
    const index = megaPixelsOptions.value.findIndex((option) => option.label === bestMatch.label)
    return index === -1 ? 0 : index
  },
  set: (index) => {
    const currentResolutionIndex = resolutionIndex.value
    if (currentResolutionIndex !== null) {
      const currentAspectRatio =
        resolutionsPerMegaPixelsOption.value[index][currentResolutionIndex].aspectRatio
      const res =
        resolutionsPerMegaPixelsOption.value[index].find(
          (res) => res.aspectRatio === currentAspectRatio,
        ) ?? resolutionsPerMegaPixelsOption.value[index][0]
      imageGeneration.width = res.width
      imageGeneration.height = res.height
    } else {
      const res = resolutionsPerMegaPixelsOption.value[index][0]
      imageGeneration.width = res.width
      imageGeneration.height = res.height
    }
  },
})

const resolutionIndex = computed({
  get: () => {
    const index = resolutionsPerMegaPixelsOption.value[megaPixelsIndex.value].findIndex(
      (res) => res.width === imageGeneration.width && res.height === imageGeneration.height,
    )
    return index === -1 ? null : index
  },
  set: (resIndex) => {
    if (resIndex !== null) {
      const res = resolutionsPerMegaPixelsOption.value[megaPixelsIndex.value][resIndex]
      imageGeneration.width = res.width
      imageGeneration.height = res.height
    }
  },
})

const widthInput = computed({
  get: () => imageGeneration.width,
  set: (value) => {
    const numValue = Number(value)
    if (!isNaN(numValue) && numValue > 0) {
      imageGeneration.width = Math.round(numValue)
    }
  },
})

const heightInput = computed({
  get: () => imageGeneration.height,
  set: (value) => {
    const numValue = Number(value)
    if (!isNaN(numValue) && numValue > 0) {
      imageGeneration.height = Math.round(numValue)
    }
  },
})
</script>
