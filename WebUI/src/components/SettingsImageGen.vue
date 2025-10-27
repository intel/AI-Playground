<template>
  <div class="flex flex-col gap-6 p-1">
    <!-- Image Gen Presets -->
    <h2 class="text-xl font-semibold text-center">Image Gen Presets</h2>
    <div class="grid grid-cols-3 gap-3">
      <div
        v-for="preset in presets"
        :key="preset.id"
        class="relative rounded-lg overflow-hidden cursor-pointer transition-all duration-200 border-2 aspect-square"
        :class="[
          selectedPreset === preset.id
            ? 'border-blue-500 ring-2 ring-blue-400'
            : 'border-transparent hover:border-blue-500',
        ]"
        @click="() => (selectedPreset = preset.id)"
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

    <!-- Draft Settings -->
    <div class="flex flex-col gap-4">
      <h2 class="text-lg font-semibold">Draft Settings</h2>
      <p class="text-sm text-gray-400">
        Quick generation of low-resolution images. Ideal for fast prototyping.
      </p>
      <div class="flex gap-2">
        <span
          v-for="tag in ['Fast', 'Draft']"
          :key="tag"
          class="px-3 py-1 text-xs bg-purple-600 rounded-full"
        >
          {{ tag }}
        </span>
      </div>

      <!-- Device -->
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Device</Label>
        <DeviceSelector :backend="'sd-backend'" />
      </div>

      <!-- Width -->
      <div class="flex flex-col gap-2">
        <Label>Width: 512</Label>
        <slide-bar v-model:current="width" :min="256" :max="2048" :step="64"></slide-bar>
      </div>

      <!-- Height -->
      <div class="flex flex-col gap-2">
        <Label>Height: 512</Label>
        <slide-bar v-model:current="height" :min="256" :max="2048" :step="64"></slide-bar>
      </div>

      <!-- Fast Mode -->
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Fast Mode</Label>
        <Checkbox id="fast-mode" :checked="fastMode" />
      </div>

      <!-- Steps -->
      <div class="flex flex-col gap-2">
        <Label>Steps: 4</Label>
        <slide-bar v-model:current="steps" :min="1" :max="50" :step="1"></slide-bar>
      </div>

      <!-- CFG -->
      <div class="flex flex-col gap-2">
        <Label>CFG: 1</Label>
        <slide-bar v-model:current="cfg" :min="0" :max="10" :step="1"></slide-bar>
      </div>

      <!-- Batch Count -->
      <div class="flex flex-col gap-2">
        <Label>Batch Count: 4</Label>
        <slide-bar v-model:current="batchCount" :min="1" :max="20" :step="1"></slide-bar>
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
        <Label>Seed: -1</Label>
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
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import DeviceSelector from '@/components/DeviceSelector.vue'
import SlideBar from '@/components/SlideBar.vue'
import RandomNumber from '@/components/RandomNumber.vue'

const presets = ref([
  {id: 'draft', name: 'Draft', image: '/src/assets/image/draft.png'},
  {id: 'hd', name: 'HD', image: '/src/assets/image/hd.png'},
  {id: 'flux', name: 'Flux Schnell', image: '/src/assets/image/flux.png'},
  {id: 'faceswap', name: 'FaceSwap', image: '/src/assets/image/faceswap.png'},
  {id: 'acer', name: 'Acer VisionArt', image: '/src/assets/image/acer.png'},
  {id: 'manual', name: 'Manual', image: '/src/assets/image/manual.png'},
])

const selectedPreset = ref('draft')
const width = ref(512)
const height = ref(512)
const fastMode = ref(true)
const steps = ref(4)
const cfg = ref(1)
const batchCount = ref(4)
const negativePrompt = ref('bad image, nsfw, ')
const seed = ref(-1)
</script>
