<script setup lang="ts">
import { computed } from 'vue'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'

export interface VariantOption {
  id: string
  name: string
  value: string
  icon?: string
  /** Parent preset name — used by contextual help mode */
  presetName?: string
}

interface Props {
  options: VariantOption[]
  modelValue?: string
  defaultValue?: string
  columns?: number
}

const props = withDefaults(defineProps<Props>(), {
  columns: 3,
  defaultValue: undefined,
})

const emits = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const selectedValue = computed({
  get: () => props.modelValue ?? props.defaultValue ?? '',
  set: (value: string) => {
    emits('update:modelValue', value)
  },
})

const gridClass = computed(() => {
  const gridColsMap: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    5: 'grid-cols-5',
    6: 'grid-cols-6',
  }
  return `grid ${gridColsMap[props.columns] || 'grid-cols-3'} gap-2`
})
</script>

<template>
  <RadioGroup v-model="selectedValue" :class="gridClass">
    <div v-for="option in options" :key="option.id">
      <RadioGroupItem :id="option.id" :value="option.value" class="peer sr-only" />
      <Label
        :for="option.id"
        :title="option.name"
        :data-aipg-preset-name="option.presetName ?? undefined"
        :data-aipg-variant-name="option.presetName ? option.value : undefined"
        class="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover px-2 py-1.5 text-sm min-w-0 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary"
      >
        <span class="truncate max-w-full">{{ option.name }}</span>
      </Label>
    </div>
  </RadioGroup>
</template>
