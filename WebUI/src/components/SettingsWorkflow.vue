<template>
  <div class="flex flex-col gap-6 p-1">
    <PresetSelector
      :categories="categories"
      :model-value="presetsStore.activePresetName || undefined"
      @update:model-value="handlePresetChange"
      @update:variant="handleVariantChange"
    />

    <TooltipProvider :delay-duration="200">
      <div class="flex flex-col gap-4">
        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">
            {{ languages.DEVICE }}
          </Label>
          <DeviceSelector :backend="backendToService[imageGeneration.backend]" />
        </div>

        <div class="flex flex-col gap-2">
          <AspectRatioPicker
            v-if="modifiableOrDisplayed('resolution')"
            :disabled="!modifiable('resolution')"
          />
        </div>

        <div
          v-if="modifiableOrDisplayed('inferenceSteps')"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
        >
          <div class="flex items-center justify-between gap-2 min-w-0 w-[120px]">
            <Label class="whitespace-nowrap truncate min-w-0">
              {{ languages.SETTINGS_MODEL_IMAGE_STEPS }}: {{ imageGeneration.inferenceSteps }}
            </Label>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
                {{ languages.SETTINGS_IMAGE_INFO_STEPS }}
              </TooltipContent>
            </Tooltip>
          </div>
          <Slider
            v-model="imageGeneration.inferenceSteps"
            :min="1"
            :max="50"
            :step="1"
            :disabled="!modifiable('inferenceSteps')"
          />
        </div>

        <div
          v-if="modifiableOrDisplayed('batchSize')"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
        >
          <div class="flex items-center justify-between gap-2 min-w-0 w-[120px]">
            <Label class="whitespace-nowrap truncate min-w-0">
              {{ languages.SETTINGS_MODEL_BATCH_COUNT }}: {{ imageGeneration.batchSize }}
            </Label>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
                {{ languages.SETTINGS_IMAGE_INFO_BATCH_COUNT }}
              </TooltipContent>
            </Tooltip>
          </div>
          <Slider
            v-model="imageGeneration.batchSize"
            :min="1"
            :max="20"
            :step="1"
            :disabled="!modifiable('batchSize')"
          />
        </div>

        <div v-if="modifiableOrDisplayed('negativePrompt')" class="flex flex-col gap-2">
          <div class="flex items-center justify-between gap-2 min-w-0 max-w-[120px]">
            <Label class="truncate min-w-0">
              {{ languages.SETTINGS_MODEL_NEGATIVE_PROMPT }}
            </Label>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
                {{ languages.SETTINGS_IMAGE_INFO_NEGATIVE_PROMPT }}
              </TooltipContent>
            </Tooltip>
          </div>
          <textarea
            class="h-24 rounded-lg resize-none bg-input border border-border text-foreground p-2"
            v-model="imageGeneration.negativePrompt"
            :disabled="!modifiable('negativePrompt')"
          ></textarea>
        </div>

        <div v-if="modifiableOrDisplayed('seed')" class="flex flex-col gap-2">
          <div class="flex items-center justify-between gap-2 min-w-0 max-w-[120px]">
            <Label class="truncate min-w-0"> {{ languages.SETTINGS_MODEL_SEED }}: {{ imageGeneration.seed }} </Label>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
                {{ languages.SETTINGS_IMAGE_INFO_SEED }}
              </TooltipContent>
            </Tooltip>
          </div>
          <random-number
            v-model:value="imageGeneration.seed"
            :default="-1"
            :min="0"
            :max="4294967295"
            :scale="1"
            :disabled="!modifiable('seed')"
          ></random-number>
        </div>

        <div
          v-if="modifiableOrDisplayed('showPreview')"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
        >
          <div class="flex items-center justify-between gap-2 min-w-0 w-[120px]">
            <Label class="whitespace-nowrap truncate min-w-0">
              {{ languages.SETTINGS_MODEL_SHOW_PREVIEW || 'Show Preview' }}
            </Label>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
                {{ languages.SETTINGS_IMAGE_INFO_SHOW_PREVIEW }}
              </TooltipContent>
            </Tooltip>
          </div>
          <Checkbox
            :model-value="imageGeneration.showPreview"
            :disabled="!modifiable('showPreview')"
            @update:model-value="(value) => (imageGeneration.showPreview = value === true)"
          />
        </div>

        <ComfyDynamic></ComfyDynamic>

        <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
          <button class="mt-4" @click="imageGeneration.resetActivePresetSettings">
            <div class="svg-icon i-refresh">Reset</div>
            {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
          </button>
        </div>

        <div
          v-if="currentPreset?.type === 'comfy' && currentPreset?.backend === 'comfyui'"
          class="max-w-md mx-auto flex items-center gap-2"
        >
          <a
            :href="backendServices.info.find((item) => item.serviceName === 'comfyui-backend')?.baseUrl"
            target="_blank"
            class="flex-1"
          >
            <Button variant="outline" class="w-full"> Open ComfyUI </Button>
          </a>
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
              {{ languages.SETTINGS_IMAGE_INFO_COMFYUI }}
            </TooltipContent>
          </Tooltip>
        </div>

      <!-- todo: needs to actually do something -->
      <Button variant="outline" class="max-w-md mx-auto"> Create New Preset</Button>
      </div>
    </TooltipProvider>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import DeviceSelector from '@/components/DeviceSelector.vue'
import RandomNumber from '@/components/RandomNumber.vue'
import {
  backendToService,
  useImageGenerationPresets,
} from '@/assets/js/store/imageGenerationPresets.ts'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import ComfyDynamic from '@/components/SettingsImageComfyDynamic.vue'
import { usePresets } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import AspectRatioPicker from './AspectRatioPicker.vue'
import PresetSelector from './PresetSelector.vue'

interface Props {
  categories: string[]
  title: string
}

const _props = defineProps<Props>()

const imageGeneration = useImageGenerationPresets()
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const backendServices = useBackendServices()

const currentPreset = computed(() => {
  return presetsStore.activePreset
})

async function handlePresetChange(presetName: string) {
  await presetSwitching.switchPreset(presetName, {
    skipModeSwitch: true, // We're already in the correct mode
  })
}

async function handleVariantChange(presetName: string, variantName: string | null) {
  if (variantName) {
    await presetSwitching.switchPreset(presetName, {
      variant: variantName,
      skipModeSwitch: true,
    })
  }
}

const modifiableOrDisplayed = (settingName: string) =>
  imageGeneration.settingIsRelevant(settingName)

const modifiable = (settingName: string) => imageGeneration.isModifiable(settingName)
</script>
