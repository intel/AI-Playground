<template>
  <div v-if="selectedPreset" class="flex flex-col gap-6">
    <!-- Informational card: thumbnail, name, description and tags. The extra
         right padding keeps the sidebar's floating close arrow (rendered by
         SideModalBase with hide-header) off the card content. -->
    <section
      role="group"
      :aria-label="`${selectedPreset.name} preset information`"
      :data-aipg-preset-name="selectedPreset.name"
      class="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3 pr-8"
    >
      <div class="flex flex-row items-start gap-3">
        <div
          :aria-label="selectedPreset.name"
          class="relative shrink-0 w-28 h-28 rounded-lg overflow-hidden border border-border shadow-md"
        >
          <img
            v-if="selectedPreset.image"
            class="absolute inset-0 w-full h-full object-cover"
            :src="selectedPreset.image"
            :alt="selectedPreset.name"
          />
          <div class="absolute bottom-0 w-full bg-background/60 text-center py-1">
            <span class="text-foreground text-sm font-semibold">
              {{ selectedPreset.name }}
            </span>
          </div>
        </div>
        <div class="flex flex-col gap-1 min-w-0">
          <p v-if="infoDescription" class="text-sm text-muted-foreground whitespace-pre-line">
            {{ infoDescription }}
          </p>
        </div>
      </div>

      <div
        v-if="
          presetsStore.activePresetWithVariant?.tags &&
          presetsStore.activePresetWithVariant.tags.length > 0
        "
        class="flex flex-wrap gap-2"
      >
        <span
          v-for="tag in presetsStore.activePresetWithVariant.tags"
          :key="tag"
          class="px-2 py-0.5 text-xs bg-primary text-primary-foreground rounded-full"
        >
          {{ tag }}
        </span>
      </div>
    </section>

    <!-- Variant picker, aligned with the label/control grid used by the other settings. -->
    <div
      v-if="variantSelectorOptions.length > 1"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">Variant</Label>
      <VariantSelector
        v-model="selectedVariantValue"
        :options="variantSelectorOptions"
        :columns="Math.min(variantSelectorOptions.length, 3)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, onMounted } from 'vue'
import { usePresets } from '@/assets/js/store/presets'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { extendedDescriptionText } from '@/assets/js/help/presetHelp'
import { Label } from '@/components/ui/label'
import VariantSelector, { type VariantOption } from '@/components/VariantSelector.vue'
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
  const presetName = selectedPreset.value?.name ?? ''
  return availableVariants.value.map((variant, index) => ({
    id: `variant-${index}`,
    name: variant.displayName ?? variant.name,
    value: variant.name,
    presetName,
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

const extendedDescription = computed(() =>
  extendedDescriptionText(selectedPreset.value, activeVariantName.value),
)

// The "info" description shown beside the preset icon: the extended how-to text
// (same content the info box used to show), falling back to the preset's base
// description. Deliberately NOT the variant-merged description, which is the
// quality-mode (fast/quality) blurb.
const infoDescription = computed(
  () => extendedDescription.value || selectedPreset.value?.description,
)

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
