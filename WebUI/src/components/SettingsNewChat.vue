<template>
  <div class="flex flex-col gap-6 p-4">
    <div class="flex flex-col gap-3">
      <h2 class="text-lg font-semibold text-center">Chat Presets</h2>
      <div class="grid grid-cols-3 gap-3">
        <button
          v-for="preset in presets"
          :key="preset.id"
          class="flex flex-col items-center justify-center gap-2 p-4 rounded-lg border-2 border-transparent hover:border-blue-500 transition-colors"
          :class="preset.bgClass"
        >
          <div class="text-3xl">{{ preset.icon }}</div>
          <span class="text-xs font-medium">{{ preset.name }}</span>
        </button>
      </div>
    </div>

    <!-- OpenVINO Settings Section -->
    <div class="flex flex-col gap-4">
      <h2 class="text-lg font-semibold">OpenVINO Settings</h2>
      <p class="text-sm text-gray-400">
        Optimized for Intel hardware with OpenVINO framework. Provides efficient and fast AI
        processing.
      </p>

      <!-- Tags -->
      <div class="flex gap-2">
        <span class="px-3 py-1 text-xs bg-blue-600 rounded-full">Intel</span>
        <span class="px-3 py-1 text-xs bg-purple-600 rounded-full">Optimized</span>
        <span class="px-3 py-1 text-xs bg-green-600 rounded-full">Fast</span>
      </div>

      <!-- Device Selection -->
      <div class="flex flex-col gap-2">
        <Label>Device</Label>
        <select class="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm">
          <option>Intel Arc GPU</option>
        </select>
      </div>

      <!-- Model Selection -->
      <div class="flex flex-col gap-2">
        <Label>Models</Label>
        <select class="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm">
          <option>Phi-3.5 mini Instruct</option>
        </select>
      </div>

      <!-- Add Model Button -->
      <Button variant="outline" class="w-full">Add Model</Button>

      <!-- Documents -->
      <Button variant="outline" class="w-full justify-start">
        Documents (0)
      </Button>

      <!-- Token Size Input -->
      <div class="flex flex-col gap-2">
        <Label for="token-size">Token size</Label>
        <Input
          id="token-size"
          type="number"
          value="1024"
          class="bg-gray-800 border-gray-700"
        />
      </div>

      <!-- Metrics Checkbox -->
      <div class="flex items-center gap-2">
        <Checkbox id="metrics" />
        <Label for="metrics" class="cursor-pointer">Metrics</Label>
      </div>

      <!-- Embeddings -->
      <div class="flex flex-col gap-2">
        <Label>Embeddings</Label>
        <select class="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm">
          <option>Select Embeddings</option>
        </select>
      </div>

      <!-- Create New Preset Button -->
      <Button class="w-full bg-blue-600 hover:bg-blue-700 mt-2">
        Create New Preset
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const presets = [
  {id: 1, name: 'OpenVINO', icon: '🔷', bgClass: 'bg-blue-900/30'},
  {id: 2, name: 'Llama.cpp', icon: '🦙', bgClass: 'bg-green-900/30'},
  {id: 3, name: 'DeepSeek', icon: '🧠', bgClass: 'bg-blue-800/30'},
  {id: 4, name: 'NPU Chat', icon: '💎', bgClass: 'bg-blue-900/30'},
  {id: 5, name: 'Manual Mode', icon: '🔧', bgClass: 'bg-gray-800/30'},
]
</script>
