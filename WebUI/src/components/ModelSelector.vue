<script lang="ts" setup>
import { nextTick, ref } from 'vue'
import { useTextInference } from '@/assets/js/store/textInference'
import { usePresets } from '@/assets/js/store/presets'
import { useBackendServices } from '@/assets/js/store/backendServices'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDownIcon, MagnifyingGlassIcon } from '@heroicons/vue/24/solid'
import ModelCapabilities from './ModelCapabilities.vue'
import CapabilityIcons from './CapabilityIcons.vue'
import { modelHasCapability, type CapabilityKey } from '@/assets/js/capabilities'

const textInference = useTextInference()
const presetsStore = usePresets()
const backendServices = useBackendServices()

const value = computed(
  () =>
    textInference.llmModels.filter((m) => m.type === textInference.backend).find((m) => m.active)
      ?.name ?? '',
)

// Get current model's capabilities
const currentModel = computed(() => {
  return textInference.llmModels.find((m) => m.active && m.type === textInference.backend)
})

// User-driven picker controls: a case-insensitive substring search and a set of
// capability filters toggled from the icon row. These narrow the list on top of
// any preset-level requirements (Home Agent tool-calling, Phison large-MoE, …).
const open = ref(false)
const search = ref('')
const activeFilters = ref<Set<CapabilityKey>>(new Set())
const searchInput = ref<HTMLInputElement | null>(null)

function toggleFilter(key: CapabilityKey) {
  const next = new Set(activeFilters.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  activeFilters.value = next
}

// reka-ui focuses the first menu item when the content opens; prevent that and
// focus the search field instead so the user can type immediately.
function onOpenAutoFocus(e: Event) {
  e.preventDefault()
  nextTick(() => searchInput.value?.focus())
}

const items = computed(() => {
  const activePreset = presetsStore.activePresetWithVariant
  const requirements = {
    vision: activePreset?.type === 'chat' && activePreset.requiresVision === true,
    toolCalling: activePreset?.type === 'chat' && activePreset.requiresToolCalling === true,
    reasoning: activePreset?.type === 'chat' && activePreset.requiresReasoning === true,
    npuSupport: activePreset?.type === 'chat' && activePreset.requiresNpuSupport === true,
    txt2TxtOnly: activePreset?.type === 'chat' && activePreset.filterTxt2TxtOnly === true,
    largeMoeOnly: activePreset?.type === 'chat' && activePreset.filterLargeMoeOnly === true,
    advancedMode: activePreset?.type === 'chat' && activePreset.advancedMode === true,
  }
  const searchLc = search.value.trim().toLowerCase()

  return textInference.llmModels
    .filter((m) => m.type === textInference.backend)
    .filter((m) => {
      // Case-insensitive substring search on the visible label (last path segment).
      // Applied to every backend, including cloud.
      if (!searchLc) return true
      const label = (m.name.split('/').at(-1) ?? m.name).toLowerCase()
      return label.includes(searchLc)
    })
    .filter((m) => {
      // Cloud Mode models come from a remote provider's /v1/models list and
      // carry no capability metadata (vision/tool-calling/etc. are all unknown,
      // hence false). The preset-requirement and custom-model filters below would
      // therefore drop every cloud model, leaving the picker empty. Remote models
      // can't be filtered on unknown capabilities, so always surface them.
      if (textInference.backend === 'cloud') return true
      // Large MoE models only load via Phison aiDAPTIV+ SSD offload. On systems where
      // Phison isn't detected they can't run, so hide them from every chat preset's
      // picker (e.g. Agentic on a non-Phison box) instead of leaking them in. This
      // mirrors how the aiDAPTIV™ preset itself is gated on `phisonSsdDetected`.
      if (m.largeMoe && !backendServices.phisonSsdDetected) return false
      // Restrict to large Mixture-of-Experts models only (e.g. the Phison aiDAPTIV+ preset)
      if (requirements.largeMoeOnly && !m.largeMoe) return false
      // Filter by preset requirements
      if (requirements.vision && !m.supportsVision) return false
      if (requirements.toolCalling && !m.supportsToolCalling) return false
      if (requirements.reasoning && !m.supportsReasoning) return false
      if (requirements.npuSupport && !m.npuSupport) return false
      if (textInference.backend === 'openVINO') {
        if (textInference.runningOnOpenvinoNpu && !m.npuSupport) return false
        if (!textInference.runningOnOpenvinoNpu && m.npuSupport) return false
      }
      // Filter out vision and reasoning models for txt2txt only presets
      if (requirements.txt2TxtOnly && (m.supportsVision || m.supportsReasoning)) return false
      // User-selected capability filters (AND): only show models with every
      // selected capability. Deselected capabilities don't filter.
      for (const key of activeFilters.value) {
        if (!modelHasCapability(m, key)) return false
      }
      // Only show predefined models unless advancedMode is enabled OR
      // custom model explicitly matches the preset's requirements
      if (!requirements.advancedMode && !m.isPredefined) {
        // For custom models, only show if they match at least one requirement
        const hasMatchingRequirement =
          (requirements.vision && m.supportsVision) ||
          (requirements.toolCalling && m.supportsToolCalling) ||
          (requirements.reasoning && m.supportsReasoning) ||
          (requirements.npuSupport && m.npuSupport)

        // Show basic models in txt2txt presets only if they don't have vision/reasoning
        const qualifiesForTxt2Txt =
          requirements.txt2TxtOnly &&
          !m.supportsVision &&
          !m.supportsReasoning &&
          !m.supportsToolCalling &&
          !m.npuSupport

        if (!hasMatchingRequirement && !qualifiesForTxt2Txt) return false
      }
      return true
    })
    .map((item) => ({
      label: item.name.split('/').at(-1) ?? item.name,
      value: item.name,
      active: item.downloaded,
      supportsToolCalling: item.supportsToolCalling,
      supportsVision: item.supportsVision,
      supportsReasoning: item.supportsReasoning,
      maxContextSize: item.maxContextSize,
      npuSupport: item.npuSupport,
    }))
})

const selectedItem = computed(() => {
  return (
    items.value.find((item) => item.value === value.value) || {
      label: 'Select...',
      value: '',
      active: false,
    }
  )
})

// Auto-select first model when current selection is not in the filtered list
watchEffect(() => {
  const currentValue = value.value
  const availableItems = items.value

  // If current selection is not in the filtered list, select the first available
  if (availableItems.length > 0 && !availableItems.some((item) => item.value === currentValue)) {
    textInference.selectModel(textInference.backend, availableItems[0].value)
  }
})
</script>

<template>
  <DropdownMenu v-model:open="open">
    <DropdownMenuTrigger as-child>
      <button class="w-full">
        <div
          class="w-full h-[30px] rounded-md bg-card border border-border text-foreground px-3 flex items-center gap-2 overflow-hidden"
        >
          <div
            class="w-2 h-2 rounded-full shrink-0"
            :class="selectedItem.active ? 'bg-primary' : 'bg-muted-foreground'"
          ></div>
          <span class="text-xs flex-1 min-w-0 text-left truncate">
            {{ selectedItem.label }}
          </span>
          <div class="flex items-center gap-1 shrink-0">
            <ModelCapabilities v-if="currentModel" :model="currentModel" />
            <ChevronDownIcon class="size-4 text-muted-foreground"></ChevronDownIcon>
          </div>
        </div>
      </button>
    </DropdownMenuTrigger>
    <!-- Anchored to the trigger's end (its right edge sits at the settings panel's
         right padding) so the wider menu grows left into the panel instead of
         overflowing off-screen. max-w keeps it inside the viewport on narrow windows. -->
    <DropdownMenuContent
      :align="'end'"
      class="w-[28rem] max-w-[calc(100vw-2rem)] rounded-md p-[3px] border border-border bg-card z-[100]"
      @open-auto-focus="onOpenAutoFocus"
    >
      <!-- Search + capability filters on one row. Kept outside the scrolling list
           so they stay visible, and shielded from the menu's typeahead/arrow-key
           navigation via keydown/pointerdown .stop. The search field flexes to fill
           the row, so when a capability (e.g. NPU) is hidden the layout rescales. -->
      <div class="px-2 py-2 flex items-center gap-2" @pointerdown.stop>
        <div
          class="flex flex-1 min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2"
        >
          <MagnifyingGlassIcon class="size-3.5 text-muted-foreground shrink-0" />
          <input
            ref="searchInput"
            v-model="search"
            type="text"
            placeholder="Search models…"
            class="w-full bg-transparent py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            @keydown.stop
          />
        </div>
        <div class="shrink-0">
          <CapabilityIcons
            mode="filter"
            :active-keys="activeFilters"
            icon-size="size-4"
            @toggle="toggleFilter"
          />
        </div>
      </div>
      <DropdownMenuSeparator class="bg-border" />
      <div class="py-1 max-h-[188px] overflow-y-auto">
        <div v-if="items.length === 0" class="px-4 py-2 text-xs text-muted-foreground">
          No models match your search and filters.
        </div>
        <DropdownMenuItem
          v-for="item in items"
          :key="item.value"
          @click="() => textInference.selectModel(textInference.backend, item.value)"
          class="text-sm px-4 py-1 flex items-center text-left hover:bg-muted text-foreground group"
        >
          <div class="flex items-center flex-1 min-w-0">
            <div
              class="w-2 h-2 rounded-full mr-2 shrink-0"
              :class="item.active ? 'bg-primary' : 'bg-muted-foreground'"
            ></div>
            <span class="flex-1 truncate">{{ item.label }}</span>
            <div class="flex gap-1 ml-2 shrink-0">
              <CapabilityIcons
                :model="{
                  supportsVision: item.supportsVision,
                  supportsToolCalling: item.supportsToolCalling,
                  supportsReasoning: item.supportsReasoning,
                }"
                icon-size="size-3.5"
              />
            </div>
          </div>
        </DropdownMenuItem>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
