<template>
  <div class="flex flex-col gap-6 p-1">
    <!-- Image Gen Presets -->
    <h2 class="text-xl font-semibold text-center">Image Gen Presets</h2>
    <div class="grid grid-cols-3 gap-3">
      <div
        v-for="preset in presets"
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

    <!-- Draft Settings -->
    <div class="flex flex-col gap-4">
      <h2 class="text-lg font-semibold">{{ currentPreset?.displayName }}</h2>
      <p class="text-sm text-gray-400">
        {{ currentPreset?.description }}
      </p>
      <div class="flex gap-2">
        <span
          v-for="tag in currentPreset?.tags"
          :key="tag"
          class="px-3 py-1 text-xs bg-purple-600 rounded-full"
        >
          {{ tag }}
        </span>
      </div>

      <!-- Device -->
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Device</Label>
        <DeviceSelector :backend="backendToService[imageGeneration.backend]" />
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Width: {{ imageGeneration.width }}</Label>
        <Slider
          v-model="imageGeneration.width"
          :min="256"
          :max="2048"
          :step="64"
        />
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Height: {{ imageGeneration.height }}</Label>
        <Slider
          v-model="imageGeneration.height"
          :min="256"
          :max="2048"
          :step="64"
        />
      </div>

      <!-- Fast Mode -->
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Fast Mode</Label>
        <Checkbox id="fast-mode" :checked="fastMode" />
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Steps: {{ imageGeneration.inferenceSteps }}</Label>
        <Slider
          v-model="imageGeneration.inferenceSteps"
          :min="1"
          :max="50"
          :step="1"
          :disabled="!modifiable('inferenceSteps')"
        />
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">CFG: {{ imageGeneration.guidanceScale }}</Label>
        <Slider
          v-model="imageGeneration.guidanceScale"
          :min="0"
          :max="10"
          :step="1"
        />
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Batch Count: {{ imageGeneration.batchSize }}</Label>
        <Slider
          v-model="imageGeneration.batchSize"
          :min="1"
          :max="20"
          :step="1"
        />
      </div>
      <!-- Negative Prompt -->
      <div class="flex flex-col gap-2">
        <Label>Negative Prompt:</Label>
        <textarea
          class="h-24 rounded-lg resize-none bg-gray-800 border border-gray-700 text-white p-2"
          v-model="negativePrompt"
          placeholder="bad image, nsfw, ..."
        ></textarea>
      </div>

      <!-- Seed -->
      <div class="flex flex-col gap-2">
        <Label>Seed: {{ seed }}</Label>
        <random-number
          v-model:value="seed"
          :default="-1"
          :min="0"
          :max="4294967295"
          :scale="1"
        ></random-number>
      </div>

      <!-- Open ComfyUI Button -->
      <Button variant="outline" class="max-w-md mx-auto"> Open ComfyUI</Button>

      <!-- Create New Preset Button -->
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

const imageGeneration = useImageGeneration()
const fastMode = ref(true)
const cfg = ref(1)
const batchCount = ref(4)
const negativePrompt = ref('bad image, nsfw, ')
const seed = ref(-1)

const presets = ref([
  {
    workflowName: 'Flux.1-Schnell Med Quality',
    displayName: 'Flux Schnell',
    description: 'Fast and efficient image generation with Flux models. Balances speed and quality.',
    image: '/src/assets/image/flux_schnell.png',
    tags: ['Flux', 'Efficient'],
  },
  {
    workflowName: 'Flux.1-Schnell High Quality',
    displayName: 'Flux Schnell HD',
    description: 'Fast and efficient image generation with Flux models. Favors quality over speed.',
    image: '/src/assets/image/flux_schnell.png',
    tags: ['Flux', 'Efficient', 'High Quality'],
  },
  {
    workflowName: 'FaceSwap-HD',
    displayName: 'FaceSwap',
    description: 'Specialized for swapping faces in images. Ensures realistic results.',
    image: '/src/assets/image/faceswap.png',
    tags: ['FaceSwap', 'Realistic'],
  },
  {
    workflowName: 'Acer VisionArt',
    displayName: 'Acer VisionArt',
    description: 'Artistic image generation with Acer\'s vision models. Creates unique visual styles.',
    image: '/src/assets/image/acer_visionart.png',
    tags: ['Artistic', 'Acer'],
  },
])

const currentPreset = computed(() => {
  return presets.value.find(preset => preset.workflowName === imageGeneration.activeWorkflowName)
})

const modifiableOrDisplayed = (setting: Setting) =>
  imageGeneration.activeWorkflow.modifiableSettings.includes(setting) ||
  imageGeneration.activeWorkflow.displayedSettings.includes(setting)

const modifiable = (setting: Setting) =>
  imageGeneration.activeWorkflow.modifiableSettings.includes(setting)
</script>
