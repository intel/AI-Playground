<template>
  <div class="flex flex-col gap-6 p-1">
    <h2 class="text-xl font-semibold text-center">{{ title }}</h2>
    <div class="grid grid-cols-3 gap-3">
      <div
        v-for="preset in presets"
        :key="preset.name"
        class="relative rounded-lg overflow-hidden cursor-pointer transition-all duration-200 border-2 aspect-square"
        :class="[
          imageGeneration.activePresetName === preset.name
            ? 'border-blue-500 ring-2 ring-blue-400'
            : 'border-transparent hover:border-blue-500',
        ]"
        @click="() => (imageGeneration.activePresetName = preset.name)"
      >
        <img
          class="absolute inset-0 w-full h-full object-cover"
          :src="preset.image"
          :alt="preset.name"
        />
        <div class="absolute bottom-0 w-full bg-black/60 text-center py-2">
          <span class="text-white text-sm font-semibold">
            {{ preset.name }}
          </span>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-4">
      <div class="flex items-center gap-3">
        <h2 class="text-lg font-semibold">{{ currentPreset?.name }}</h2>
        <drop-selector
          v-if="currentPreset?.variants && currentPreset.variants.length > 0"
          :array="variantOptions"
          @change="onVariantChange"
        >
          <template #selected>
            <span class="text-sm text-gray-400">
              {{ activeVariantName || 'Default' }}
            </span>
          </template>
          <template #list="slotItem">
            <span>{{ slotItem.item.name }}</span>
          </template>
        </drop-selector>
      </div>
      <p class="text-sm text-gray-400">
        {{ currentPreset?.description }}
      </p>
      <div class="flex gap-2">
        <span
          v-for="tag in imageGeneration.activePreset?.tags ?? []"
          :key="tag"
          class="px-3 py-1 text-xs bg-purple-600 rounded-full"
        >
          {{ tag }}
        </span>
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">
          {{ languages.DEVICE }}
        </Label>
        <DeviceSelector :backend="backendToService[imageGeneration.backend as 'comfyui' | 'default']" />
      </div>

      <div class="flex flex-col gap-2">
        <AspectRatioPicker
          v-if="modifiableOrDisplayed('resolution')"
          :disabled="!modifiable('resolution')"
        />
      </div>

      <!-- todo: What is this supposed to do?  -->
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Fast Mode</Label>
        <Checkbox id="fast-mode" :checked="fastMode" />
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
        v-if="modifiableOrDisplayed('guidanceScale')"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <Label class="whitespace-nowrap">
          {{ languages.SETTINGS_MODEL_IMAGE_CFG }}: {{ imageGeneration.guidanceScale }}
        </Label>
        <Slider
          v-model="imageGeneration.guidanceScale"
          :min="0"
          :max="10"
          :step="1"
          :disabled="!modifiable('guidanceScale')"
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
          class="h-24 rounded-lg resize-none bg-gray-800 border border-gray-700 text-white p-2"
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

      <div class="border-t border-color-spilter items-center flex-wrap grid grid-cols-1 gap-2">
        <button class="mt-4" @click="imageGeneration.resetActivePresetSettings">
          <div class="svg-icon i-refresh">Reset</div>
          {{ languages.COM_LOAD_WORKFLOW_DEFAULTS }}
        </button>
      </div>

      <a v-if="imageGeneration.activePreset?.backend === 'comfyui'"
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
import DropSelector from '@/components/DropSelector.vue'
import {
  backendToService,
  useImageGenerationPresets
} from "@/assets/js/store/imageGenerationPresets.ts";
import { useBackendServices } from "@/assets/js/store/backendServices.ts";
import ComfyDynamic from "@/components/SettingsImageComfyDynamic.vue";
import { usePresets, type Preset } from "@/assets/js/store/presets";
import AspectRatioPicker from "./AspectRatioPicker.vue";

interface Props {
  presets: Preset[]
  title: string
}

const props = defineProps<Props>()

const imageGeneration = useImageGenerationPresets()
const presetsStore = usePresets()
const backendServices = useBackendServices()
const fastMode = ref(true)

const currentPreset = computed(() => {
  return props.presets.find(preset => preset.name === imageGeneration.activePresetName)
})

const modifiableOrDisplayed = (settingName: string) =>
  imageGeneration.settingIsRelevant(settingName)

const modifiable = (settingName: string) =>
  imageGeneration.isModifiable(settingName)

const activeVariantName = computed(() => {
  if (!imageGeneration.activePresetName) return null
  return presetsStore.activeVariantName[imageGeneration.activePresetName] || null
})

const variantOptions = computed(() => {
  if (!currentPreset.value?.variants) return []
  return [
    { name: 'Default', value: null },
    ...currentPreset.value.variants.map(v => ({ name: v.name, value: v.name }))
  ]
})

function onVariantChange(selected: { name: string; value: string | null }) {
  if (!imageGeneration.activePresetName) return
  presetsStore.setActiveVariant(imageGeneration.activePresetName, selected.value)
}
</script>
