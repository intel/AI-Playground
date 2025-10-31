<template>
  <div class="flex flex-col gap-6 p-1">
    <h2 class="text-xl font-semibold text-center">Video Gen Presets</h2>
    <div class="grid grid-cols-3 gap-3">
      <div
        v-for="preset in videoPresets"
        :key="preset.workflowName"
        class="relative rounded-lg overflow-hidden cursor-pointer transition-all duration-200 border-2 aspect-square"
        :class="[
          imageGeneration.activeWorkflowName === preset.workflowName
            ? 'border-blue-500 ring-2 ring-blue-400'
            : 'border-transparent hover:border-blue-500',
        ]"
        @click="() => (imageGeneration.activeWorkflowName = preset.workflowName)"
      >
        <img
          class="absolute inset-0 w-full h-full object-cover"
          :src="preset.image"
          :alt="preset.displayName"
        />
        <div class="absolute bottom-0 w-full bg-black/60 text-center py-2">
          <span class="text-white text-sm font-semibold">
            {{ preset.displayName }}
          </span>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-4">
      <h2 class="text-lg font-semibold">{{ currentPreset?.displayName }}</h2>
      <p class="text-sm text-gray-400">
        {{ currentPreset?.description }}
      </p>
      <div class="flex gap-2">
        <span
          v-for="tag in imageGeneration.activeWorkflow.tags"
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
        <DeviceSelector :backend="backendToService[imageGeneration.backend]" />
      </div>

      <div
        v-if="modifiableOrDisplayed('resolution')"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <Label class="whitespace-nowrap">
          {{ languages.SETTINGS_MODEL_IMAGE_WIDTH }}: {{ imageGeneration.width }}
        </Label>
        <Slider
          v-model="imageGeneration.width"
          :min="256"
          :max="2048"
          :step="64"
          :disabled="!modifiable('resolution')"
        />
      </div>

      <div
        v-if="modifiableOrDisplayed('resolution')"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <Label class="whitespace-nowrap">
          {{ languages.SETTINGS_MODEL_IMAGE_HEIGHT }}: {{ imageGeneration.height }}
        </Label>
        <Slider
          v-model="imageGeneration.height"
          :min="256"
          :max="2048"
          :step="64"
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
        <button class="mt-4" @click="imageGeneration.resetActiveWorkflowSettings">
          <div class="svg-icon i-refresh">Reset</div>
          {{ languages.COM_LOAD_WORKFLOW_DEFAULTS }}
        </button>
      </div>

      <a v-if="imageGeneration.backend === 'comfyui'"
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
  Setting,
  useImageGeneration
} from "@/assets/js/store/imageGeneration.ts";
import { useBackendServices } from "@/assets/js/store/backendServices.ts";
import ComfyDynamic from "@/components/SettingsImageComfyDynamic.vue";

const imageGeneration = useImageGeneration()
const backendServices = useBackendServices()
const fastMode = ref(true)

const videoPresets = ref([
  {
    workflowName: 'Video-Txt2Vid',
    displayName: 'Text to Video - LTX',
    description: 'Generates videos from text prompts using LTX models. Creates dynamic video content.',
    image: '/src/assets/image/flux_schnell.png',
  },
  {
    workflowName: 'Video-Img2Vid',
    displayName: 'Image to Video - LTX',
    description: 'Converts images to videos with LTX technology. Smooth transitions and animations.',
    image: '/src/assets/image/faceswap.png',
  },
  {
    workflowName: 'Video-Start2End',
    displayName: 'Start to End - LTX',
    description: 'Generates videos from start and end frames with LTX. Smooth interpolation.',
    image: '/src/assets/image/flux_schnell.png',
  },
  {
    workflowName: 'Wan2.1-VACE_Img2Video-4Steps',
    displayName: 'Image to Video - VACE',
    description: 'Image-to-video conversion with VACE models. Focus on Speed.',
    image: '/src/assets/image/acer_visionart.png',
  },
  {
    workflowName: 'Wan2.1-VACE_Img2Video-20Steps',
    displayName: 'Image to Video - VACE',
    description: 'Image-to-video conversion with VACE models. High-quality video output.',
    image: '/src/assets/image/acer_visionart.png',
  },
  {
    workflowName: 'Wan2.1-VACE_Video2Video',
    displayName: 'Video to Video - VACE',
    description: 'Transforms existing videos using VACE models. Enables creative video editing.',
    image: '/src/assets/image/acer_visionart.png',
  },
])


const currentPreset = computed(() => {
  return videoPresets.value.find(preset => preset.workflowName === imageGeneration.activeWorkflowName)
})

const modifiableOrDisplayed = (setting: Setting) =>
  imageGeneration.activeWorkflow.modifiableSettings.includes(setting) ||
  imageGeneration.activeWorkflow.displayedSettings.includes(setting)

const modifiable = (setting: Setting) =>
  imageGeneration.activeWorkflow.modifiableSettings.includes(setting)
</script>
