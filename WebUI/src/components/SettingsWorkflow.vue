<template>
  <div class="flex flex-col gap-6 p-1">
    <PresetSelector
      :categories="categories"
      :model-value="presetsStore.activePresetName || undefined"
      @update:model-value="handlePresetChange"
      @update:variant="handleVariantChange"
    />

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
        <Label class="whitespace-nowrap">
          {{ languages.SETTINGS_MODEL_IMAGE_STEPS }}: {{ imageGeneration.inferenceSteps }}
        </Label>
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
        <Label class="whitespace-nowrap">
          {{ languages.SETTINGS_MODEL_BATCH_COUNT }}: {{ imageGeneration.batchSize }}
        </Label>
        <Slider
          v-model="imageGeneration.batchSize"
          :min="1"
          :max="20"
          :step="1"
          :disabled="!modifiable('batchSize')"
        />
      </div>

      <div v-if="modifiableOrDisplayed('negativePrompt')" class="flex flex-col gap-2">
        <Label>
          {{ languages.SETTINGS_MODEL_NEGATIVE_PROMPT }}
        </Label>
        <textarea
          class="h-24 rounded-lg resize-none bg-input border border-border text-foreground p-2"
          v-model="imageGeneration.negativePrompt"
          :disabled="!modifiable('negativePrompt')"
        ></textarea>
      </div>

      <div v-if="modifiableOrDisplayed('seed')" class="flex flex-col gap-2">
        <Label>
          {{ languages.SETTINGS_MODEL_SEED }}: {{ imageGeneration.seed }}
        </Label>
        <random-number
          v-model:value="imageGeneration.seed"
          :default="-1"
          :min="0"
          :max="4294967295"
          :scale="1"
          :disabled="!modifiable('seed')"
        ></random-number>
      </div>
      <ComfyDynamic></ComfyDynamic>

      <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
        <button class="mt-4" @click="imageGeneration.resetActivePresetSettings">
          <div class="svg-icon i-refresh">Reset</div>
          {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
        </button>
      </div>

      <a v-if="currentPreset?.backend === 'comfyui'"
         :href="backendServices.info.find((item) => item.serviceName === 'comfyui-backend')?.baseUrl"
         target="_blank"
         class="max-w-md mx-auto"
      >
        <Button variant="outline" class="w-full">
          Open ComfyUI
        </Button>
      </a>

      <!-- todo: needs to actually do something -->
      <Button variant="outline" class="max-w-md mx-auto"> Create New Preset</Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import DeviceSelector from '@/components/DeviceSelector.vue'
import RandomNumber from '@/components/RandomNumber.vue'
import {
  backendToService,
  useImageGenerationPresets
} from "@/assets/js/store/imageGenerationPresets.ts";
import { useBackendServices } from "@/assets/js/store/backendServices.ts";
import ComfyDynamic from "@/components/SettingsImageComfyDynamic.vue";
import { usePresets } from "@/assets/js/store/presets";
import AspectRatioPicker from "./AspectRatioPicker.vue";
import PresetSelector from "./PresetSelector.vue";

interface Props {
  categories: string[]
  title: string
}

const props = defineProps<Props>()

const imageGeneration = useImageGenerationPresets()
const presetsStore = usePresets()
const backendServices = useBackendServices()
const fastMode = ref(true)

const currentPreset = computed(() => {
  return presetsStore.activePreset
})

function handlePresetChange(presetName: string) {
  presetsStore.activePresetName = presetName
}

function handleVariantChange(presetName: string, variantName: string | null) {
  presetsStore.setActiveVariant(presetName, variantName)
}

const modifiableOrDisplayed = (settingName: string) =>
  imageGeneration.settingIsRelevant(settingName)

const modifiable = (settingName: string) =>
  imageGeneration.isModifiable(settingName)
</script>
