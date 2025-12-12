<template>
  <div class="flex flex-col gap-6">
    <Card class="bg-muted p-3">
      <div class="grid grid-cols-3 gap-3">
        <div
          v-for="preset in filteredPresets"
          :key="preset.name"
          class="relative rounded-lg overflow-hidden transition-all duration-200 border-2 aspect-square shadow-md"
          :class="[
            selectedPresetName === preset.name
              ? 'border-primary ring-2 ring-primary'
              : 'border-transparent hover:border-primary',
            isPresetDisabled(preset) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
          ]"
          @click="isPresetDisabled(preset) ? showDisabledReason(preset) : selectPreset(preset.name)"
        >
          <img
            v-if="preset.image"
            class="absolute inset-0 w-full h-full object-cover"
            :src="preset.image"
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
          :columns="Math.min(variantSelectorOptions.length, 3)"
        />
      </div>
      <p v-if="selectedPreset.description" class="text-sm text-muted-foreground">
        {{ presetsStore.activePresetWithVariant?.description || selectedPreset.description }}
      </p>
      <div v-if="presetsStore.activePresetWithVariant?.tags && presetsStore.activePresetWithVariant.tags.length > 0" class="flex gap-2">
        <span
          v-for="tag in presetsStore.activePresetWithVariant.tags"
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
import { usePresets, type Preset, type ChatPreset } from '@/assets/js/store/presets'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useTextInference, backendToService } from '@/assets/js/store/textInference'
import VariantSelector, { type VariantOption } from '@/components/VariantSelector.vue'
import { Card } from '@/components/ui/card'
import * as toast from '@/assets/js/toast'
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
const backendServices = useBackendServices()
const textInference = useTextInference()

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

  const options: VariantOption[] = []

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
    // If no variant selected but preset has variants, return first variant name
    if (!variant && selectedPreset.value?.variants && selectedPreset.value.variants.length > 0) {
      return selectedPreset.value.variants[0].name
    }
    return variant || ''
  },
  set: (value: string) => {
    if (!selectedPresetName.value) return
    // Value should never be empty string now since we removed Default option
    presetsStore.setActiveVariant(selectedPresetName.value, value)
    emits('update:variant', selectedPresetName.value, value)
  },
})

function isPresetDisabled(preset: Preset): boolean {
  if (preset.type === 'chat') {
    const chatPreset = preset as ChatPreset
    
    // Check if NPU is required but not available
    if (chatPreset.requiresNpuSupport) {
      const hasNpuDevice = backendServices.info
        .find((s) => s.serviceName === 'openvino-backend')
        ?.devices?.some((d) => d.id.includes('NPU'))
      
      if (!hasNpuDevice) {
        return true // Disable if NPU required but not available
      }
    }
    
    // Check if any backend is available
    const hasAvailableBackend = chatPreset.backends.some((backend) => {
      const serviceName = backendToService[backend]
      return backendServices.info.find((s) => s.serviceName === serviceName)
    })
    return !hasAvailableBackend
  }
  return false
}

function showDisabledReason(preset: Preset) {
  if (preset.type === 'chat') {
    const chatPreset = preset as ChatPreset
    if (chatPreset.requiresNpuSupport) {
      toast.show('NPU device not available. This preset requires an Intel NPU.', {
        style: {
          content: { background: '#3b82f6', color: '#ffffff' },
        },
      })
    } else {
      toast.show(`Required backend not available for ${preset.name}`, {
        style: {
          content: { background: '#3b82f6', color: '#ffffff' },
        },
      })
    }
  }
}

function selectPreset(presetName: string) {
  // Don't allow selecting if preset switching is in progress
  if (textInference?.isPresetSwitching) {
    toast.warning('Please wait for current preset change to complete')
    return
  }

  const preset = filteredPresets.value.find((p) => p.name === presetName)
  if (!preset) return

  // Check if preset is actually available
  if (isPresetDisabled(preset)) {
    showDisabledReason(preset)
    return
  }

  emits('update:modelValue', presetName)

  // Update lastUsed for the preset's category (or use type as fallback)
  const categoryKey = preset.category || (preset.type === 'chat' ? 'chat' : undefined)
  if (categoryKey) {
    presetsStore.setLastUsedPreset(categoryKey, presetName)
  }

  // Auto-select first variant if preset has variants and none is selected
  if (preset.variants && preset.variants.length > 0) {
    const currentVariant = presetsStore.activeVariantName[presetName]
    if (!currentVariant) {
      const firstVariantName = preset.variants[0].name
      presetsStore.setActiveVariant(presetName, firstVariantName)
      emits('update:variant', presetName, firstVariantName)
    }
  }
}

// Auto-select lastUsed preset on mount if no preset is selected
onMounted(() => {
  if (!selectedPresetName.value) {
    const categories =
      props.categories && props.categories.length > 0
        ? props.categories
        : props.type === 'chat'
          ? ['chat']
          : []

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
    const newPresetNames = newPresets
      .map((p) => p.name)
      .sort()
      .join(',')
    const oldPresetNames =
      oldPresets
        ?.map((p) => p.name)
        .sort()
        .join(',') || ''

    // Skip if preset names haven't actually changed (just array reference changed)
    if (newPresetNames === oldPresetNames && selectedPresetName.value) {
      return
    }

    if (selectedPresetName.value) {
      const stillExists = newPresets.some((p) => p.name === selectedPresetName.value)
      if (!stillExists) {
        // Current selection is no longer in the filtered list
        const categories =
          props.categories && props.categories.length > 0
            ? props.categories
            : props.type === 'chat'
              ? ['chat']
              : []
        const lastUsed = categories.length > 0 ? presetsStore.getLastUsedPreset(categories) : null
        if (lastUsed && newPresets.some((p) => p.name === lastUsed)) {
          emits('update:modelValue', lastUsed)
        } else if (newPresets.length > 0) {
          emits('update:modelValue', newPresets[0].name)
        }
      }
    }
  },
  { deep: false }, // Don't deep watch, we'll do our own comparison
)
</script>
