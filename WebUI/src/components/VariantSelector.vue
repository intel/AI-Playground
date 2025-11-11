<!--
  VariantSelector Component
  
  A card-based variant selector following the PaymentMethod pattern from shadcn-vue.
  Displays options as selectable cards with icons in a grid layout.
  
  Usage:
  <VariantSelector
    v-model="selectedVariant"
    :options="variantOptions"
    :columns="3"
  />
  
  Example options:
  const variantOptions = [
    { id: 'variant1', name: 'Variant 1', value: 'variant1' },
    { id: 'variant2', name: 'Variant 2', value: 'variant2', icon: '<svg>...</svg>' },
  ]
-->
<script setup lang="ts">
import { computed } from 'vue'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'

export interface VariantOption {
  id: string
  name: string
  value: string
  icon?: string
}

interface Props {
  options: VariantOption[]
  modelValue?: string
  defaultValue?: string
  columns?: 1 | 2 | 3 | 4 | 5 | 6
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
  return `grid ${gridColsMap[props.columns] || 'grid-cols-3'} gap-4`
})
</script>

<template>
  <RadioGroup
    v-model="selectedValue"
    :class="gridClass"
  >
    <div v-for="option in options" :key="option.id">
      <RadioGroupItem
        :id="option.id"
        :value="option.value"
        class="peer sr-only"
      />
      <Label
        :for="option.id"
        class="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary"
      >
        <svg
          v-if="!option.icon"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          class="mb-3 h-6 w-6"
        >
          <rect width="20" height="14" x="2" y="5" rx="2" />
          <path d="M2 10h20" />
        </svg>
        <span
          v-else
          v-html="option.icon"
          class="mb-3 h-6 w-6"
        />
        {{ option.name }}
      </Label>
    </div>
  </RadioGroup>
</template>

