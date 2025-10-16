<template>
  <div>
    <teleport to="body">
      <add-l-l-m-dialog
        v-show="showModelRequestDialog"
        ref="addLLMCompt"
        @close="showModelRequestDialog = false"
      />
    </teleport>
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

        <div class="flex flex-col gap-2">
          <Label>{{ languages.DEVICE }}</Label>
          <DeviceSelector :backend="backendToService[textInference.backend]" />
        </div>

        <div class="flex flex-col gap-2">
          <Label>{{ languages.MODEL }}</Label>
          <ModelSelector />
        </div>

        <Button variant="outline" class="w-full" @click="() => showModelRequestDialog=true">
          {{ languages.COM_ADD + ' ' + languages.MODEL }}
        </Button>

        <!-- todo: processing -->
        <Button
          class="flex items-center justify-center flex-none gap-2 border border-white rounded-md text-sm px-4 py-1"
          @click="showUploader = !showUploader"
          :disabled="processing"
          :title="languages.ANSWER_RAG_OPEN_DIALOG"
          :class="{ 'demo-mode-overlay-content': demoMode.answer.show }"
        >
            <span class="w-4 h-4 svg-icon i-rag flex-none"></span
            ><span>{{ documentButtonText }}</span>
        </Button>

        <!-- Token Size Input -->
        <div class="flex flex-col gap-2">
          <label class="text-white whitespace-nowrap">{{ languages.ANSWER_MAX_TOKENS }}</label>
          <input
            type="number"
            v-model="textInference.maxTokens"
            min="0"
            max="4096"
            step="1"
            class="rounded-sm text-white text-center h-7 w-20 leading-7 p-0 bg-transparent border border-white"
          />
        </div>

        <div class="flex items-center gap-2">
          <Checkbox id="metrics" @click="textInference.toggleMetrics()" />
          <Label for="metrics" class="cursor-pointer">{{ languages.ANSWER_METRICS }}</Label>
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
      <rag v-if="showUploader" ref="ragPanel" @close="showUploader = false"></rag>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { backendToService, useTextInference } from "@/assets/js/store/textInference.ts";
import DeviceSelector from "@/components/DeviceSelector.vue";
import ModelSelector from "@/components/ModelSelector.vue";
import AddLLMDialog from "@/components/AddLLMDialog.vue";
import { ref } from "vue";
import { useI18N } from "@/assets/js/store/i18n.ts";
import { useDemoMode } from "@/assets/js/store/demoMode.ts";
import Rag from "@/components/Rag.vue";

const showModelRequestDialog = ref(false)
const showUploader = ref(false)
const processing = ref(false)
const i18nState = useI18N().state
const textInference = useTextInference()
const demoMode = useDemoMode()

const documentButtonText = computed(() => {
  const stats = documentStats.value
  if (stats.total === 0) {
    return 'Add Documents'
  } else {
    return `${i18nState.RAG_DOCUMENTS} (${stats.enabled}/${stats.total} ${i18nState.RAG_ENABLED})`
  }
})

const documentStats = computed(() => {
  const totalDocs = textInference.ragList.length
  const enabledDocs = textInference.ragList.filter((doc) => doc.isChecked).length
  return {total: totalDocs, enabled: enabledDocs}
})

const presets = [
  {id: 1, name: 'OpenVINO', icon: '🔷', bgClass: 'bg-blue-900/30'},
  {id: 2, name: 'Llama.cpp', icon: '🦙', bgClass: 'bg-green-900/30'},
  {id: 3, name: 'DeepSeek', icon: '🧠', bgClass: 'bg-blue-800/30'},
  {id: 4, name: 'NPU Chat', icon: '💎', bgClass: 'bg-blue-900/30'},
  {id: 5, name: 'Manual Mode', icon: '🔧', bgClass: 'bg-gray-800/30'},
]
</script>
