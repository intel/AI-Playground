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
      <h2 class="text-xl font-semibold text-center">Chat Presets</h2>
      <div class="grid grid-cols-3 gap-3">
        <div
          v-for="backendInfo in Object.values(backendInfos)"
          :key="backendInfo.name"
          class="relative rounded-l overflow-hidden cursor-pointer transition-all duration-200 border-2 aspect-square"
          :class="[
            textInference.backend === backendInfo.name
              ? 'border-blue-500 ring-2 ring-blue-400'
              : 'border-transparent hover:border-blue-500',
              !backendInfo.isRunning && 'grayscale opacity-80'
          ]"
          @click="() => handlePresetSelectionClick(backendInfo)"
        >
          <img
            class="absolute inset-0 w-full h-full object-cover"
            :src="`/src/assets/image/${backendInfo.name}.png`"
            :alt="backendInfo.displayName"
          />
          <div class="absolute bottom-0 w-full bg-black/60 text-center py-2">
      <span class="text-white text-sm font-semibold">
        {{ backendInfo.displayName }}
      </span>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-4">
        <h2 class="text-lg font-semibold">
          {{ backendInfos[textInference.backend]?.displayName + ' ' + languages.COM_SETTINGS }}</h2>
        <p class="text-sm text-gray-400">
          {{ backendInfos[textInference.backend]?.description }}
        </p>

        <div class="flex gap-2">
          <span
            v-for="tag in backendInfos[textInference.backend]?.tags"
            :key="tag"
            class="px-3 py-1 text-xs bg-purple-600 rounded-full">
            {{ tag }}
          </span>
        </div>
        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">{{ languages.DEVICE }}</Label>
          <DeviceSelector :backend="backendToService[textInference.backend]" />
        </div>
        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
          <ModelSelector />
        </div>
        <Button variant="outline" class="self-start w-auto" @click="() => showModelRequestDialog=true">
          {{ languages.COM_ADD + ' ' + languages.MODEL }}
        </Button>

        <!-- todo: processing -->
        <Button
          variant="outline" class="self-start w-auto"
          @click="showUploader = !showUploader"
          :disabled="processing"
          :title="languages.ANSWER_RAG_OPEN_DIALOG"
          :class="{ 'demo-mode-overlay-content': demoMode.answer.show }"
        >
          <span>{{ documentButtonText }}</span>
        </Button>
        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <label class="whitespace-nowrap">{{ languages.ANSWER_MAX_TOKENS }}</label>
          <input
            type="number"
            v-model="textInference.maxTokens"
            min="0"
            max="4096"
            step="1"
            class="rounded-sm text-white text-center h-7 w-20 leading-7 p-0 bg-transparent border border-white"
          />
        </div>
        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">{{ languages.ANSWER_METRICS }}</Label>
          <Checkbox id="metrics" @click="textInference.toggleMetrics()" />
        </div>

        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">Embeddings</Label>
          <drop-down-new
            :title="languages.RAG_DOCUMENT_EMBEDDING_MODEL"
            @change="(item) => textInference.selectEmbeddingModel(textInference.backend, item)"
            :value="
              textInference.llmEmbeddingModels
                .filter((m) => m.type === textInference.backend)
                .find((m) => m.active)?.name ?? ''
            "
            :items="
              textInference.llmEmbeddingModels
                .filter((m) => m.type === textInference.backend)
                .map((item) => ({
                  label: item.name.split('/').at(-1) ?? item.name,
                  value: item.name,
                  active: item.downloaded,
                }))
            "
          ></drop-down-new>
        </div>
        <!-- todo: needs to actually do something-->
        <Button variant="outline" class="max-w-md mx-auto">
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
import { useGlobalSetup } from "@/assets/js/store/globalSetup.ts";
import DropDownNew from "@/components/DropDownNew.vue";
import { useDialogStore } from "@/assets/js/store/dialogs.ts";

type BackendInfo = {
  displayName: string
  description: string
  tags: string[]
  name: LlmBackend
  isRunning: boolean
  enabled: boolean
}

const showModelRequestDialog = ref(false)
const showUploader = ref(false)
const processing = ref(false)
const i18nState = useI18N().state
const textInference = useTextInference()
const demoMode = useDemoMode()
const backendServices = useBackendServices()
const backendInfos = computed(() => backendTypesToBackends())
const globalSetup = useGlobalSetup()
const warningDialogStore = useDialogStore()

const documentButtonText = computed(() => {
  const stats = documentStats.value
  if (stats.total === 0) {
    return 'Add Documents'
  } else {
    return `${i18nState.RAG_DOCUMENTS} (${stats.enabled})`
  }
})

const documentStats = computed(() => {
  const totalDocs = textInference.ragList.length
  const enabledDocs = textInference.ragList.filter((doc) => doc.isChecked).length
  return {total: totalDocs, enabled: enabledDocs}
})

function handlePresetSelectionClick(backendInfo: BackendInfo) {
  if (backendInfo.isRunning) {
    textInference.backend = backendInfo.name as LlmBackend
  } else {
    warningDialogStore.showWarningDialog(i18nState.SETTINGS_MODEL_REQUIREMENTS_NOT_MET, () => {
      globalSetup.loadingState = 'manageInstallations'
    })
  }
}

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
