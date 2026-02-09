<script lang="ts" setup>
import { getCurrentInstance } from 'vue'
import { useTextInference } from '@/assets/js/store/textInference'
import { usePresets } from '@/assets/js/store/presets'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDownIcon } from '@heroicons/vue/24/solid'
import ModelCapabilities from './ModelCapabilities.vue'

const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages

const textInference = useTextInference()
const presetsStore = usePresets()

const value = computed(
  () =>
    textInference.llmModels.filter((m) => m.type === textInference.backend).find((m) => m.active)
      ?.name ?? '',
)

// Get current model's capabilities
const currentModel = computed(() => {
  return textInference.llmModels.find((m) => m.active && m.type === textInference.backend)
})

const items = computed(() => {
  const activePreset = presetsStore.activePresetWithVariant
  const requirements = {
    vision: activePreset?.type === 'chat' && activePreset.requiresVision === true,
    toolCalling: activePreset?.type === 'chat' && activePreset.requiresToolCalling === true,
    reasoning: activePreset?.type === 'chat' && activePreset.requiresReasoning === true,
    npuSupport: activePreset?.type === 'chat' && activePreset.requiresNpuSupport === true,
    txt2TxtOnly: activePreset?.type === 'chat' && activePreset.filterTxt2TxtOnly === true,
    advancedMode: activePreset?.type === 'chat' && activePreset.advancedMode === true,
  }

  return textInference.llmModels
    .filter((m) => m.type === textInference.backend)
    .filter((m) => {
      // Filter by preset requirements
      if (requirements.vision && !m.supportsVision) return false
      if (requirements.toolCalling && !m.supportsToolCalling) return false
      if (requirements.reasoning && !m.supportsReasoning) return false
      if (requirements.npuSupport && !m.npuSupport) return false
      // Filter out vision and reasoning models for txt2txt only presets
      if (requirements.txt2TxtOnly && (m.supportsVision || m.supportsReasoning)) return false
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
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button>
        <div
          class="w-full h-[30px] rounded-md bg-card border border-border text-foreground px-3 flex items-center justify-between"
        >
          <div
            class="w-2 h-2 rounded-full shrink-0"
            :class="selectedItem.active ? 'bg-primary' : 'bg-muted-foreground'"
          ></div>
          <span class="text-xs flex-grow text-left px-3 text-nowrap">
            {{ selectedItem.label }}
          </span>
          <div class="flex items-center gap-1">
            <ModelCapabilities v-if="currentModel" :model="currentModel" />
            <ChevronDownIcon class="size-4 text-muted-foreground"></ChevronDownIcon>
          </div>
        </div>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      :align="'start'"
      :align-offset="-20"
      class="w-full rounded-md p-[3px] border border-border bg-card max-h-[188px] overflow-y-auto z-[100] ml-4"
    >
      <DropdownMenuLabel class="text-foreground px-3 py-2 text-sm font-medium">{{
        languages?.SETTINGS_TEXT_INFERENCE_MODEL
      }}</DropdownMenuLabel>
      <DropdownMenuSeparator class="bg-border" />
      <div class="py-1">
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
              <ModelCapabilities
                :model="{
                  name: item.label,
                  supportsVision: item.supportsVision,
                  supportsToolCalling: item.supportsToolCalling,
                  supportsReasoning: item.supportsReasoning,
                  maxContextSize: item.maxContextSize,
                  npuSupport: item.npuSupport,
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
