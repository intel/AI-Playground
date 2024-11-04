<script setup lang="ts">
import { ref, computed, watchEffect } from 'vue'
import { type SliderRootProps } from 'radix-vue'
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'radix-vue'
import { cn } from '@/lib/utils'
import { clsx } from 'clsx'
import { useImageGeneration } from '@/assets/js/store/imageGeneration'

const props = defineProps<SliderRootProps & { class?: string }>()

const aspectRatios = [
  { label: '12/5', value: 12 / 5 },
  { label: '16/9', value: 16 / 9 },
  { label: '3/2', value: 3 / 2 },
  { label: '4/3', value: 4 / 3 },
  { label: '1/1', value: 1 / 1 },
  { label: '3/4', value: 3 / 4 },
  { label: '2/3', value: 2 / 3 },
  { label: '9/16', value: 9 / 16 },
  { label: '5/12', value: 5 / 12 },
]

const megaPixelsOptions = [
  { label: '0.25', totalPixels: 512 * 512 },
  { label: '0.5', totalPixels: 704 * 704 },
  { label: '0.8', totalPixels: 896 * 896 },
  { label: '1.0', totalPixels: 1024 * 1024 },
]

function findBestResolution(totalPixels: number, aspectRatio: number) {
  const MIN_SIZE = 256
  const MAX_SIZE = 1536
  let bestWidth = 0
  let bestHeight = 0
  let minDiff = Infinity

  for (let h = MIN_SIZE; h <= MAX_SIZE; h += 64) {
    let w = aspectRatio * h
    w = Math.round(w / 64) * 64

    if (w < MIN_SIZE || w > MAX_SIZE) continue

    let actualPixels = w * h
    let diff = Math.abs(actualPixels - totalPixels)

    if (diff < minDiff) {
      minDiff = diff
      bestWidth = w
      bestHeight = h
    }
  }

  return { width: bestWidth, height: bestHeight, totalPixels: bestWidth * bestHeight }
}

const resolutionsPerMegaPixelsOption =
  megaPixelsOptions.map(megaPixels =>
    aspectRatios.map(aspectRatio => ({
      aspectRatio: aspectRatio.label,
      ...findBestResolution(megaPixels.totalPixels, aspectRatio.value)
    })))

const imageGeneration = useImageGeneration()

const megaPixelsIndex = computed({
  get: () => {
    const currentTotalPixels = imageGeneration.width * imageGeneration.height
    const bestMatch = megaPixelsOptions.map(
      option => ({ ...option, distance: Math.abs(option.totalPixels - currentTotalPixels) })
    ).sort((a, b) => a.distance - b.distance)[0]
    const index = megaPixelsOptions.findIndex(option => option.label === bestMatch.label)
    return index === -1 ? 0 : index
  },
  set: (index) => {
    const currentAspectRatio = resolutionsPerMegaPixelsOption[index][resolutionIndex.value[0]].aspectRatio;
    const res = resolutionsPerMegaPixelsOption[index].find(
      res => res.aspectRatio === currentAspectRatio
    ) ?? resolutionsPerMegaPixelsOption[index][0]
    imageGeneration.width = res.width
    imageGeneration.height = res.height
  }
})

const resolutionIndex = computed({
  get: () => {
    const index = resolutionsPerMegaPixelsOption[megaPixelsIndex.value].findIndex(
      res => res.width === imageGeneration.width && res.height === imageGeneration.height
    )
    if (index === -1) return [resolutionsPerMegaPixelsOption[megaPixelsIndex.value].findIndex(
      res => res.aspectRatio === '1/1')]
    return [index]
  },
  set: (resIndex) => {
    const res = resolutionsPerMegaPixelsOption[megaPixelsIndex.value][resIndex[0]]
    imageGeneration.width = res.width
    imageGeneration.height = res.height
  }
})

const sliderModel = computed({
  get: () => resolutionIndex.value,
  set: (value) => {
    resolutionIndex.value = value
  }
})

</script>

<template>
  <div class="flex flex-row justify-between">
    <span>{{ languages.SETTINGS_MODEL_IMAGE_SIZE }}</span>
    <div class="flex gap-2 items-baseline">
      <select id="megapixels" v-model="megaPixelsIndex"
        class="mt-1 text-center block w-full rounded-md bg-[var(--color-control-bg)] border border-gray-500"
        :disabled="props.disabled">
        <option v-for="(option, index) in megaPixelsOptions" :key="index" :value="index">{{ option.label }}</option>
      </select>
      Megapixels
    </div>
    <span class="w-[90px] text-center rounded-sm border border-[#666] py-0.5 px-2 bg-[var(--color-control-bg)]">{{
      imageGeneration.width }} x {{ imageGeneration.height }}</span>
  </div>
  <div class="flex flex-col px-10">
    <div class="flex flex-row justify-between">
      <div class="w-10 h-10 mb-2 -mr-4 -ml-4 flex flex-row items-center justify-center"
        v-for="res, i in resolutionsPerMegaPixelsOption[megaPixelsIndex]" :key="`res-${i}`">
        <div @click="() => { if (!props.disabled) resolutionIndex = [i] }" v-if="i % 2 === 0" :className="clsx(
          { 'cursor-pointer': !props.disabled },
          'bg-[var(--color-control-bg)] border',
          { 'border-gray-500': resolutionIndex[0] !== i || disabled, 'border-white': resolutionIndex[0] === i && !disabled }
        )"
          :style="{ height: `${(res.height / 60 + 12).toFixed(0)}px`, width: `${(res.width / 60 + 12).toFixed(0)}px` }">
        </div>
      </div>
    </div>

    <SliderRoot :class="cn('relative flex w-full touch-none select-none items-center', props.class)"
      v-model:="sliderModel" :min="0" :max="resolutionsPerMegaPixelsOption[megaPixelsIndex].length - 1" :step="1" :disabled="disabled">
      <SliderTrack class="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[#28282b]">
        <SliderRange :className="clsx('absolute h-full', { 'bg-gradient': !disabled })" />
      </SliderTrack>
      <SliderThumb v-if="!disabled" v-for="(_, key) in sliderModel" :key="key" :className="clsx(
        'block h-3 w-3 rounded-full border border-[#4e80ff] bg-white transition-colors',
        { 'cursor-pointer': !disabled }
      )" />
    </SliderRoot>

    <div class="mt-1.5 flex flex-row justify-between -mr-4 -ml-4">
      <span v-for="(res, i) in resolutionsPerMegaPixelsOption[megaPixelsIndex]" :key="`aspect-${i}`" :className="clsx(
        'text-center w-10 h-10 text-sm text-10 select-none',
        { 'cursor-pointer': !disabled },
        { 'font-light opacity-60': resolutionIndex[0] !== i || disabled }
      )" role="presentation" @click="() => { if (!disabled) resolutionIndex = [i] }">
        {{ res.aspectRatio }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.bg-gradient {
  background: var(--main-gradient);
}
</style>