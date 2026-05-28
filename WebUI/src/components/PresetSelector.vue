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
              {{ translatePresetName(preset.name) }}
            </span>
          </div>
        </div>
      </div>
    </Card>

    <div v-if="selectedPreset" class="flex flex-col gap-4">
      <div class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <h2 class="text-lg font-semibold">{{ translatePresetName(selectedPreset.name) }}</h2>
          <TooltipProvider v-if="extendedDescription" :delay-duration="200">
            <Tooltip>
              <TooltipTrigger as-child>
                <InformationCircleIcon
                  class="w-6 h-6 stroke-2 text-muted-foreground/60 cursor-help"
                />
              </TooltipTrigger>
              <TooltipContent
                side="right"
                class="max-w-[320px] text-sm text-justify whitespace-pre-line"
              >
                {{ translatePresetExtendedDescription(selectedPreset.name, extendedDescription) }}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <VariantSelector
          v-if="selectedPreset.variants && selectedPreset.variants.length > 0"
          v-model="selectedVariantValue"
          :options="variantSelectorOptions"
          :columns="Math.min(variantSelectorOptions.length, 3)"
        />
      </div>
      <p v-if="selectedPreset.description" class="text-sm text-muted-foreground">
        {{
          translatePresetDescription(
            selectedPreset.name,
            presetsStore.activePresetWithVariant?.description || selectedPreset.description,
          )
        }}
      </p>

      <div
        v-if="
          presetsStore.activePresetWithVariant?.tags &&
          presetsStore.activePresetWithVariant.tags.length > 0
        "
        class="flex gap-2"
      >
        <span
          v-for="tag in presetsStore.activePresetWithVariant.tags"
          :key="tag"
          class="px-3 py-1 text-xs bg-primary rounded-full"
        >
          {{ translatePresetTag(tag) }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, onMounted } from 'vue'
import { usePresets, type Preset, type ChatPreset } from '@/assets/js/store/presets'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { backendToService } from '@/assets/js/store/textInference'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import VariantSelector, { type VariantOption } from '@/components/VariantSelector.vue'
import { Card } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import * as toast from '@/assets/js/toast'
import { useI18N } from '@/assets/js/store/i18n'
import {
  translatePresetName,
  translatePresetDescription,
  translatePresetExtendedDescription,
  translatePresetTag,
  translateVariantName,
} from '@/lib/utils'

const i18nState = useI18N().state
import { InformationCircleIcon } from '@heroicons/vue/24/outline'
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
const presetSwitching = usePresetSwitching()

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

function isVariantAvailable(variant: { requiresService?: string }): boolean {
  if (!variant.requiresService) return true
  const info = backendServices.info.find((s) => s.serviceName === variant.requiresService)
  if (!info) return false
  return info.status !== 'notInstalled'
}

// Variants are now grouped by `backend` (defaulting to 'comfyui'). The Backend dropdown
// in SettingsWorkflow.vue picks which group is active; the quality radio here only shows
// variants belonging to that group, then further filters by `requiresService` availability.
const availableVariants = computed(() => {
  if (!selectedPreset.value?.variants) return []
  const presetName = selectedPreset.value.name
  const activeBackend = presetsStore.getActiveBackend(presetName) ?? 'comfyui'
  return selectedPreset.value.variants
    .filter((v) => (v.backend ?? 'comfyui') === activeBackend)
    .filter(isVariantAvailable)
})

const variantSelectorOptions = computed<VariantOption[]>(() => {
  return availableVariants.value.map((variant, index) => ({
    id: `variant-${index}`,
    name: translateVariantName(variant.displayName ?? variant.name),
    value: variant.name,
  }))
})

const selectedVariantValue = computed({
  get: () => {
    const variant = activeVariantName.value
    const available = availableVariants.value
    // If currently selected variant is unavailable, fall back to first available one
    if (variant && !available.some((v) => v.name === variant)) {
      return available[0]?.name ?? ''
    }
    // If no variant selected but preset has available variants, return the first one
    if (!variant && available.length > 0) {
      return available[0].name
    }
    return variant || ''
  },
  set: (value: string) => {
    if (!selectedPresetName.value) return
    // Emit variant change for parent to handle via orchestrator
    emits('update:variant', selectedPresetName.value, value)
  },
})

// When the previously-active variant becomes unavailable (service uninstalled, or
// persisted state from another machine), reconcile it to the first available variant.
watch(
  [selectedPresetName, availableVariants],
  ([presetName, available]) => {
    if (!presetName) return
    const current = presetsStore.activeVariantName[presetName]
    if (!current) return
    if (available.some((v) => v.name === current)) return
    if (available.length === 0) return
    emits('update:variant', presetName, available[0].name)
  },
  { immediate: true },
)

const extendedDescription = computed(() => {
  const preset = selectedPreset.value
  const raw = preset?.extendedDescription
  if (raw == null) return undefined
  if (typeof raw === 'string') return raw
  const variant = activeVariantName.value
  if (variant && variant in raw) return raw[variant]
  const first = Object.values(raw)[0]
  return typeof first === 'string' ? first : undefined
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
      toast.show(i18nState.PRESETS_REQUIRES_NPU, {
        style: {
          content: { background: '#3b82f6', color: '#ffffff' },
        },
      })
    } else {
      toast.show(`${i18nState.PRESETS_BACKEND_NOT_AVAILABLE} ${preset.name}`, {
        style: {
          content: { background: '#3b82f6', color: '#ffffff' },
        },
      })
    }
  }
}

function selectPreset(presetName: string) {
  // Don't allow selecting if preset switching is in progress
  if (presetSwitching.isSwitching) {
    toast.warning(i18nState.PRESETS_SWITCH_IN_PROGRESS)
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

  // Note: lastUsed tracking and variant selection are now handled by the orchestrator
  // when the parent component calls switchPreset()
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
