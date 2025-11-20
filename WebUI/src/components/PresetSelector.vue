<template>
  <div class="flex flex-col gap-6">
    <Card class="bg-muted p-3">
      <div class="grid grid-cols-3 gap-3">
        <div
          v-for="preset in filteredPresets"
          :key="preset.name"
          class="relative rounded-lg overflow-hidden cursor-pointer transition-all duration-200 border-2 aspect-square shadow-md"
          :class="[
            selectedPresetName === preset.name
              ? 'border-primary ring-2 ring-primary'
              : 'border-transparent hover:border-primary',
          ]"
          @click="selectPreset(preset.name)"
        >
          <img
            v-if="preset.image"
            class="absolute inset-0 w-full h-full object-cover"
            :src="preset.image"
            :alt="preset.name"
          />
          <img
            v-else-if="preset.type === 'chat'"
            class="absolute inset-0 w-full h-full object-cover"
            :src="`/src/assets/image/${preset.backend}.png`"
            :alt="preset.name"
          />
          <div class="absolute bottom-0 w-full bg-background/60 text-center py-2">
            <span class="text-foreground text-sm font-semibold">
              {{ preset.name }}
            </span>
          </div>
        </div>
      </div>
    </Card>

    <div v-if="selectedPreset" class="flex flex-col gap-4">
      <div class="flex flex-col gap-3">
        <h2 class="text-lg font-semibold">{{ selectedPreset.name }}</h2>
        <VariantSelector
          v-if="selectedPreset.variants && selectedPreset.variants.length > 0"
          v-model="selectedVariantValue"
          :options="variantSelectorOptions"
          :columns="variantSelectorOptions.length <= 3 ? variantSelectorOptions.length : 3"
        />
      </div>
      <p v-if="selectedPreset.description" class="text-sm text-muted-foreground">
        {{ presetsStore.activePresetWithVariant?.description || selectedPreset.description }}
      </p>
      <div v-if="selectedPreset.tags && selectedPreset.tags.length > 0" class="flex gap-2">
        <span
          v-for="tag in selectedPreset.tags"
          :key="tag"
          class="px-3 py-1 text-xs bg-primary rounded-full"
        >
          {{ tag }}
        </span>
      </div>
    </div>
</div>
</template>

<script setup lang="ts">
import { computed, watch, onMounted } from 'vue'
import { usePresets, type Preset } from '@/assets/js/store/presets'
import VariantSelector, { type VariantOption } from '@/components/VariantSelector.vue'
import { Card } from '@/components/ui/card'
interface Props {
  categories?: string[]
  type?: string
  modelValue?: string
}

const props = withDefaults(defineProps<Props>(), {
  categories: () => [],
  type: undefined,
  modelValue: undefined,
})

const emits = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'update:variant', presetName: string, variantName: string | null): void
}>()

const presetsStore = usePresets()

const filteredPresets = computed(() => {
  return presetsStore.getPresetsByCategories(props.categories || [], props.type)
})

const selectedPresetName = computed(() => {
  return props.modelValue || presetsStore.activePresetName
})

const selectedPreset = computed(() => {
  if (!selectedPresetName.value) return null
  return filteredPresets.value.find((p) => p.name === selectedPresetName.value) || null
})

const activeVariantName = computed(() => {
  if (!selectedPresetName.value) return null
  return presetsStore.activeVariantName[selectedPresetName.value] || null
})

const variantSelectorOptions = computed<VariantOption[]>(() => {
  if (!selectedPreset.value?.variants) return []
  
  const options: VariantOption[] = [
    {
      id: 'default',
      name: 'Default',
      value: '', // empty string for default (will be converted to null when setting)
    },
  ]
  
  selectedPreset.value.variants.forEach((variant, index) => {
    options.push({
      id: `variant-${index}`,
      name: variant.name,
      value: variant.name,
    })
  })
  
  return options
})

const selectedVariantValue = computed({
  get: () => {
    const variant = activeVariantName.value
    return variant || ''
  },
  set: (value: string) => {
    if (!selectedPresetName.value) return
    const variantName = value === '' ? null : value
    presetsStore.setActiveVariant(selectedPresetName.value, variantName)
    emits('update:variant', selectedPresetName.value, variantName)
  },
})

function selectPreset(presetName: string) {
  emits('update:modelValue', presetName)
  
  // Update lastUsed for the preset's category (or use type as fallback)
  const preset = filteredPresets.value.find((p) => p.name === presetName)
  if (preset) {
    const categoryKey = preset.category || (preset.type === 'chat' ? 'chat' : undefined)
    if (categoryKey) {
      presetsStore.setLastUsedPreset(categoryKey, presetName)
    }
  }
}

// Auto-select lastUsed preset on mount if no preset is selected
onMounted(() => {
  if (!selectedPresetName.value) {
    const categories = props.categories && props.categories.length > 0 
      ? props.categories 
      : (props.type === 'chat' ? ['chat'] : [])
    
    if (categories.length > 0) {
      const lastUsed = presetsStore.getLastUsedPreset(categories)
      if (lastUsed) {
        emits('update:modelValue', lastUsed)
      } else if (filteredPresets.value.length > 0) {
        // Fallback to first preset if no lastUsed
        emits('update:modelValue', filteredPresets.value[0].name)
      }
    } else if (filteredPresets.value.length > 0) {
      // If no categories/type specified, just select first preset
      emits('update:modelValue', filteredPresets.value[0].name)
    }
  }
})

// Watch for changes in filtered presets and auto-select if current selection is no longer valid
// Use a deep comparison to avoid triggering when the array reference changes but content is the same
watch(
  filteredPresets,
  (newPresets, oldPresets) => {
    // Only proceed if the selection actually changed (preset names differ)
    const newPresetNames = newPresets.map(p => p.name).sort().join(',')
    const oldPresetNames = oldPresets?.map(p => p.name).sort().join(',') || ''
    
    // Skip if preset names haven't actually changed (just array reference changed)
    if (newPresetNames === oldPresetNames && selectedPresetName.value) {
      return
    }
    
    if (selectedPresetName.value) {
      const stillExists = newPresets.some((p) => p.name === selectedPresetName.value)
      if (!stillExists) {
        // Current selection is no longer in the filtered list
        const categories = props.categories && props.categories.length > 0 
          ? props.categories 
          : (props.type === 'chat' ? ['chat'] : [])
        const lastUsed = categories.length > 0 ? presetsStore.getLastUsedPreset(categories) : null
        if (lastUsed && newPresets.some((p) => p.name === lastUsed)) {
          emits('update:modelValue', lastUsed)
        } else if (newPresets.length > 0) {
          emits('update:modelValue', newPresets[0].name)
        }
      }
    }
  },
  { deep: false } // Don't deep watch, we'll do our own comparison
)
</script>

