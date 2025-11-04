<template>
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Megapixels</Label>
      <drop-down-new
        :title="'Megapixels'"
        :value="megaPixelsIndex.toString()"
        :items="megaPixelsDropdownItems"
        @change="(value) => { megaPixelsIndex = parseInt(value) }"
      />
    </div>

    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Resolution</Label>
      <div class="flex gap-2 items-center">
        <input
          v-model.number="widthInput"
          type="number"
          min="1"
          class="w-full rounded-lg bg-gray-800 border border-gray-700 text-white py-1 px-2 text-center focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          :disabled="props.disabled"
        />
        <span class="text-gray-400">×</span>
        <input
          v-model.number="heightInput"
          type="number"
          min="1"
          class="w-full rounded-lg bg-gray-800 border border-gray-700 text-white py-1 px-2 text-center focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          :disabled="props.disabled"
        />
      </div>
    </div>

    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Aspect Ratio</Label>
      <div class="flex flex-row justify-between">
        <div
          v-for="(res, i) in resolutionsPerMegaPixelsOption[megaPixelsIndex]"
          :key="`res-${i}`"
          @click="
            () => {
              if (!props.disabled) resolutionIndex = i
            }
          "
          :className="
            clsx(
              'flex flex-col items-center gap-1 transition-colors',
              { 'cursor-pointer': !props.disabled },
            )
          "
        >
          <div
            :className="
              clsx('bg-black border-2 transition-colors', {
                'border-gray-600': resolutionIndex !== i || disabled,
                'border-blue-500': resolutionIndex === i && !disabled,
              })
            "
            :style="
              (() => {
                const aspectRatio = aspectRatios.find(ar => ar.label === res.aspectRatio)?.value ?? 1
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
                'text-gray-500': resolutionIndex !== i || disabled,
                'text-blue-500 font-semibold': resolutionIndex === i && !disabled,
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
import { findBestResolution, useImageGeneration } from '@/assets/js/store/imageGeneration'
import { Label } from '@/components/ui/label'
import DropDownNew from '@/components/DropDownNew.vue'

const props = defineProps<SliderRootProps & { class?: string }>()

const imageGeneration = useImageGeneration()

const aspectRatios = [
  { label: '16/9', value: 16 / 9 },
  { label: '4/3', value: 4 / 3 },
  { label: '1/1', value: 1 / 1 },
  { label: '3/4', value: 3 / 4 },
  { label: '9/16', value: 9 / 16 },
]

const megaPixelsOptions = computed(() => {
  if (imageGeneration.activeWorkflow.tags.includes('sd1.5')) {
    return [
      { label: '0.25', totalPixels: 512 * 512 },
      { label: '0.5', totalPixels: 704 * 704 },
    ]
  } else if (imageGeneration.activeWorkflow.tags.includes('LTX Video')) {
    return [
      { label: '0.1', totalPixels: 320 * 320 },
      { label: '0.25', totalPixels: 512 * 512 },
      { label: '0.35', totalPixels: 605 * 605 },
      { label: '0.5', totalPixels: 704 * 704 },
    ]
  } else {
    return [
      { label: '0.25', totalPixels: 512 * 512 },
      { label: '0.5', totalPixels: 704 * 704 },
      { label: '0.8', totalPixels: 896 * 896 },
      { label: '1.0', totalPixels: 1024 * 1024 },
    ]
  }
})

const megaPixelsDropdownItems = computed(() =>
  megaPixelsOptions.value.map((option, index) => ({
    label: `${option.label} MP`,
    value: index.toString(),
    active: index === megaPixelsIndex.value,
  })),
)

const resolutionsPerMegaPixelsOption = computed(() =>
  megaPixelsOptions.value.map((megaPixels) =>
    aspectRatios.map((aspectRatio) => ({
      aspectRatio: aspectRatio.label,
      ...findBestResolution(megaPixels.totalPixels, aspectRatio.value),
    })),
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
