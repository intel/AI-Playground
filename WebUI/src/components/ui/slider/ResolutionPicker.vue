<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import type { SliderRootEmits, SliderRootProps } from 'radix-vue'
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'radix-vue'
import { cn } from '@/lib/utils'
import { clsx } from 'clsx'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'

const props = defineProps<SliderRootProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<SliderRootEmits>()

const globalSetup = useGlobalSetup();

const resolutionsSDXL = [{
  width: 1536,
  height: 640,
  aspectRatio: '12/5'
}, {
  width: 1344,
  height: 768,
  aspectRatio: '16/9'
}, {
  width: 1248,
  height: 832,
  aspectRatio: '3/2'
}, {
  width: 1152,
  height: 864,
  aspectRatio: '4/3'
}, {
  width: 1024,
  height: 1024,
  aspectRatio: '1/1'
}, {
  width: 864,
  height: 1152,
  aspectRatio: '3/4'
}, {
  width: 832,
  height: 1248,
  aspectRatio: '2/3'
}, {
  width: 768,
  height: 1344,
  aspectRatio: '9/16'
}, {
  width: 640,
  height: 1536,
  aspectRatio: '5/12'
}]

const resolutionsSD15 = [{
  width: 768,
  height: 320,
  aspectRatio: '12/5'
}, {
  width: 672,
  height: 384,
  aspectRatio: '16/9'
}, {
  width: 624,
  height: 416,
  aspectRatio: '3/2'
}, {
  width: 576,
  height: 432,
  aspectRatio: '4/3'
}, {
  width: 512,
  height: 512,
  aspectRatio: '1/1'
}, {
  width: 432,
  height: 576,
  aspectRatio: '3/4'
}, {
  width: 416,
  height: 624,
  aspectRatio: '2/3'
}, {
  width: 384,
  height: 672,
  aspectRatio: '9/16'
}, {
  width: 320,
  height: 768,
  aspectRatio: '5/12'
}]

const isSDXL = computed(() => globalSetup.modelSettings.resolution === 1)

const resolutions = computed(() => {
  if (isSDXL.value) return resolutionsSDXL
  return resolutionsSD15
})

const resolutionIndexFromModelSettings = computed(() => {
  const fromModelSettings = resolutions.value.findIndex(r => r.width === globalSetup.modelSettings.width && r.height === globalSetup.modelSettings.height)
  if (fromModelSettings !== -1) return fromModelSettings
  return resolutions.value.findIndex(r => r.aspectRatio === '1/1')
})

const model = ref([resolutionIndexFromModelSettings.value])

watchEffect(() => {
  model.value = [resolutionIndexFromModelSettings.value]
})
watchEffect(() => {
  if (props.disabled) return;
  globalSetup.applyModelSettings(resolutions.value[model.value[0]])
})
</script>

<template>
  <div class="flex flex-col px-10">
    <div class="flex flex-row justify-between">
      <div class="w-10 h-10 mb-2 -mr-4 -ml-4 flex flex-row items-center justify-center" v-for="res, i in resolutions">
        <div @click="() => { if (!props.disabled) model[0] = i }" v-if="i % 2 === 0"
          :className="clsx({ 'cursor-pointer': !props.disabled }, 'bg-[var(--color-control-bg)] border', { 'border-gray-500': model[0] !== i || disabled, 'border-white': model[0] === i && !disabled })"
          :style="{ height: `${(res.height / (isSDXL ? 40 : 25) ).toFixed(0)}px`, width: `${(res.width / (isSDXL ? 40 : 25)).toFixed(0)}px` }">
        </div>
      </div>
    </div>
    <SliderRoot :class="cn(
      'relative flex w-full touch-none select-none items-center',
      props.class,
    )" v-model="model" :min="0" :max="resolutions.length - 1" :step="1" :disabled="disabled">
      <SliderTrack class="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[#28282b]">
        <SliderRange :className="clsx('absolute h-full', {'bg-gradient': !disabled})"/>
      </SliderTrack>
      <SliderThumb v-if="!disabled" v-for="(_, key) in model" :key="key"
        :className="clsx('block h-3 w-3 rounded-full border border-[#4e80ff] bg-white transition-colors', { 'cursor-pointer': !disabled })" />

    </SliderRoot>
    <div className='mt-1.5 flex flex-row justify-between -mr-4 -ml-4'>
      <span v-for="i in Array.from({ length: resolutions.length }).map((_, i) => i)" :key="`asdf-${i}`"
        :className="clsx('text-center w-10 h-10 text-sm text-10 select-none', { 'cursor-pointer': !disabled }, { 'font-light opacity-60': model[0] !== i || disabled })"
        role='presentation' @click="() => { if (!disabled) model[0] = i }">
        {{ i % 1 === 0 ? resolutions[i].aspectRatio : '|' }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.bg-gradient {
  background: var(--main-gradient);
}
</style>