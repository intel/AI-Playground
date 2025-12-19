<script setup lang="ts">
import type { SliderRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui'
import { cn } from '@/lib/utils'
import { computed } from 'vue'

interface SingleValueSliderProps extends Omit<SliderRootProps, 'modelValue'> {
  modelValue?: number | number[]
  class?: HTMLAttributes['class']
}

const props = defineProps<SingleValueSliderProps>()

const emits = defineEmits<{
  'update:modelValue': [value: number | number[]]
  valueCommit: [value: number[]]
}>()

const delegatedProps = reactiveOmit(props, 'class', 'modelValue')

// Convert single value to array for internal use
const internalModelValue = computed({
  get: () => {
    const value = props.modelValue
    if (value === null || value === undefined) return undefined
    return Array.isArray(value) ? value : [value]
  },
  set: (value) => {
    // Emit single value instead of array
    if (value && value.length > 0) {
      emits('update:modelValue', value[0])
    }
  },
})

// Handle valueCommit event
const handleValueCommit = (value: number[]) => {
  emits('valueCommit', value)
}
</script>

<template>
  <SliderRoot
    :class="
      cn(
        'relative flex w-full touch-none select-none items-center data-[orientation=vertical]:flex-col data-[orientation=vertical]:w-2 data-[orientation=vertical]:h-full',
        props.class,
      )
    "
    v-bind="delegatedProps"
    :model-value="internalModelValue"
    @update:model-value="(value) => (internalModelValue = value)"
    @value-commit="handleValueCommit"
  >
    <SliderTrack
      class="relative h-2 w-full data-[orientation=vertical]:w-2 grow overflow-hidden rounded-full bg-secondary"
    >
      <SliderRange class="absolute h-full data-[orientation=vertical]:w-full bg-primary" />
    </SliderTrack>
    <SliderThumb
      v-for="(_, key) in internalModelValue"
      :key="key"
      class="block h-5 w-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
    />
  </SliderRoot>
</template>
