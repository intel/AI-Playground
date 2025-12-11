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
  RESOLUTION_TABLE,
  getResolutionFromTable,
  findBestResolution,
} from '@/assets/js/store/imageGenerationUtils'
import { Label } from '@/components/ui/label'
import DropDownNew from '@/components/DropDownNew.vue'

const props = defineProps<SliderRootProps & { class?: string }>()

const imageGeneration = useImageGenerationPresets()

// All aspect ratios (landscape to portrait order)
const aspectRatios = [
  { label: '21/9', value: 21 / 9 },
  { label: '16/9', value: 16 / 9 },
  { label: '3/2', value: 3 / 2 },
  { label: '4/3', value: 4 / 3 },
  { label: '1/1', value: 1 / 1 },
  { label: '3/4', value: 3 / 4 },
  { label: '2/3', value: 2 / 3 },
  { label: '9/16', value: 9 / 16 },
  { label: '9/21', value: 9 / 21 },
]

const megaPixelsOptions = computed(() => {
  const tags = imageGeneration.activePreset?.tags ?? []
  // Draft tier (sd1.5): 0.5, 0.8 MP only
  if (tags.includes('DreamShaper') || tags.includes('SD1.5')) {
    return [
      { label: '0.25', totalPixels: 512 * 512 },
      { label: '0.5', totalPixels: 704 * 704 },
    ]
  }
  // LTX Video: custom tiers (uses dynamic calculation)
  if (tags.includes('LTX Video')) {
    return [
      { label: '0.1', totalPixels: 320 * 320 },
      { label: '0.25', totalPixels: 512 * 512 },
      { label: '0.35', totalPixels: 605 * 605 },
      { label: '0.5', totalPixels: 704 * 704 },
    ]
  }
  // Pro tier (flux): 0.25, 0.5, 0.8, 1.0, 1.2, 1.5 MP
  if (tags.some((tag) => tag.toLowerCase().includes('flux') || tag.toLowerCase().includes('z-image'))) {
    return [
      { label: '0.25', totalPixels: 512 * 512 },
      { label: '0.5', totalPixels: 704 * 704 },
      { label: '0.8', totalPixels: 896 * 896 },
      { label: '1.0', totalPixels: 1024 * 1024 },
      { label: '1.2', totalPixels: 1120 * 1120 },
      { label: '1.5', totalPixels: 1248 * 1248 },
    ]
  }
  // HD tier (default/sdxl): 0.25, 0.5, 0.8, 1.0 MP
  return [
    { label: '0.25', totalPixels: 512 * 512 },
    { label: '0.5', totalPixels: 704 * 704 },
    { label: '0.8', totalPixels: 896 * 896 },
    { label: '1.0', totalPixels: 1024 * 1024 },
  ]
})

const megaPixelsDropdownItems = computed(() =>
  megaPixelsOptions.value.map((option, index) => ({
    label: `${option.label} MP`,
    value: index.toString(),
    active: index === megaPixelsIndex.value,
  })),
)

// Check if we should use the lookup table or dynamic calculation
const useLookupTable = computed(() => {
  const tags = imageGeneration.activePreset?.tags ?? []
  // LTX Video uses dynamic calculation due to custom MP tiers
  return !tags.includes('LTX Video')
})

const resolutionsPerMegaPixelsOption = computed(() =>
  megaPixelsOptions.value.map((megaPixels) =>
    aspectRatios.map((aspectRatio) => {
      // Try lookup table first for standard presets
      if (useLookupTable.value && RESOLUTION_TABLE[megaPixels.label]) {
        const tableRes = getResolutionFromTable(megaPixels.label, aspectRatio.label)
        if (tableRes) {
          return {
            aspectRatio: aspectRatio.label,
            ...tableRes,
          }
        }
      }
      // Fall back to dynamic calculation
      return {
        aspectRatio: aspectRatio.label,
        ...findBestResolution(megaPixels.totalPixels, aspectRatio.value),
      }
    }),
  ),
)

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
