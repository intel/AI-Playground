<template>
  <div>
    <teleport to="body">
      <add-l-l-m-dialog
        v-show="showModelRequestDialog"
        ref="addLLMCompt"
        @close="showModelRequestDialog = false"
      />
    </teleport>
    <div class="flex flex-col gap-6 p-1">
      <div class="grid grid-cols-3 gap-3">
        <div
          v-for="backend in Object.values(backends)"
          :key="backend.name"
          class="relative rounded-l overflow-hidden cursor-pointer transition-all duration-200 border-2 aspect-square"
          :class="[
      textInference.backend === backend.name
        ? 'border-blue-500 ring-2 ring-blue-400'
        : 'border-transparent hover:border-blue-500'
    ]"
          @click="() => textInference.backend = backend.name as LlmBackend"
        >
          <img
            class="absolute inset-0 w-full h-full object-cover"
            :src="`/src/assets/image/${backend.name}.png`"
            :alt="backend.displayName"
          />
          <div class="absolute bottom-0 w-full bg-black/60 text-center py-2">
      <span class="text-white text-sm font-semibold">
        {{ backend.displayName }}
      </span>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-4">
        <h2 class="text-lg font-semibold">
          {{ backends[textInference.backend]?.displayName + ' ' + languages.COM_SETTINGS }}</h2>
        <p class="text-sm text-gray-400">
          {{ backends[textInference.backend]?.description }}
        </p>

        <div class="flex gap-2">
          <span
            v-for="tag in backends[textInference.backend]?.tags"
            :key="tag"
            class="px-3 py-1 text-xs bg-purple-600 rounded-full">
            {{ tag }}
          </span>
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
          variant="outline" class="w-full"
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
        <Button variant="outline" class="w-full">
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
import {
  backendToService,
  LlmBackend, textInferenceBackendDescription,
  textInferenceBackendDisplayName, textInferenceBackendTags,
  useTextInference
} from "@/assets/js/store/textInference.ts";
import DeviceSelector from "@/components/DeviceSelector.vue";
import ModelSelector from "@/components/ModelSelector.vue";
import AddLLMDialog from "@/components/AddLLMDialog.vue";
import { ref } from "vue";
import { useI18N } from "@/assets/js/store/i18n.ts";
import { useDemoMode } from "@/assets/js/store/demoMode.ts";
import Rag from "@/components/Rag.vue";
import { llmBackendTypes } from "@/types/shared.ts";
import { useBackendServices } from "@/assets/js/store/backendServices.ts";

const showModelRequestDialog = ref(false)
const showUploader = ref(false)
const processing = ref(false)
const i18nState = useI18N().state
const textInference = useTextInference()
const demoMode = useDemoMode()
const backendServices = useBackendServices()
const backends = computed(() => backendTypesToBackends())

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

function isEnabled(name: LlmBackend) {
  const backendName = mapBackendNames(name)
  return backendServices.info.find((item) => item.serviceName === backendName) !== undefined
}

function isRunning(name: LlmBackend) {
  const backendName = mapBackendNames(name)
  return backendServices.info.find((item) => item.serviceName === backendName)?.status === 'running'
}

function mapBackendNames(name: LlmBackend): BackendServiceName | undefined {
  if (name === 'ipexLLM') return 'ai-backend'
  if (name === 'llamaCPP') return 'llamacpp-backend'
  if (name === 'openVINO') return 'openvino-backend'
  if (name === 'ollama') return 'ollama-backend' as BackendServiceName
  return undefined
}

function backendTypesToBackends() {
  type BackendInfo = {
    displayName: string
    description: string
    tags: string[]
    name: LlmBackend
    isRunning: boolean
    enabled: boolean
  }

  const result: Partial<Record<LlmBackend, BackendInfo>> = {}

  llmBackendTypes
    .filter((b) => b !== 'ipexLLM')
    .forEach(llmBackend => {
      result[llmBackend] = {
        displayName: textInferenceBackendDisplayName[llmBackend],
        description: textInferenceBackendDescription[llmBackend],
        tags: textInferenceBackendTags[llmBackend],
        name: llmBackend,
        isRunning: isRunning(llmBackend),
        enabled: isEnabled(llmBackend),
      }
    })

  return result
}
</script>
