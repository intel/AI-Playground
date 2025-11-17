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
      <PresetSelector
        type="chat"
        :model-value="presetsStore.activePresetName || undefined"
        @update:model-value="handlePresetChange"
        @update:variant="handleVariantChange"
      />

      <div class="flex flex-col gap-4">
        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">{{ languages.MICROPHONE }}</Label>
          <MicrophoneSelector />
        </div>
        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">{{ languages.DEVICE }}</Label>
          <DeviceSelector :backend="backendToService[textInference.backend]" />
        </div>
        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
          <ModelSelector />
        </div>
        <Button
          variant="secondary"
          class="self-start w-auto px-3 py-1.5 rounded text-sm"
          @click="() => (showModelRequestDialog = true)"
        >
          {{ languages.COM_ADD + ' ' + languages.MODEL }}
        </Button>

        <!-- todo: processing -->
        <Button
          variant="secondary"
          class="self-start w-auto px-3 py-1.5 rounded text-sm"
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
            class="rounded-sm text-foreground text-center h-7 w-20 leading-7 p-0 bg-transparent border border-border"
          />
        </div>
        <div
          v-if="textInference.contextSizeSettingSupported"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
        >
          <Label class="whitespace-nowrap">{{ languages.ANSWER_CONTEXT_SIZE }}</Label>
          <input
            type="number"
            v-model="textInference.contextSize"
            min="512"
            max="131072"
            step="512"
            class="rounded-sm text-foreground text-center h-7 w-20 leading-7 p-0 bg-transparent border border-border"
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
        <Button variant="secondary" class="max-w-md mx-auto px-3 py-1.5 rounded text-sm"> Create New Preset</Button>
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
  LlmBackend,
  textInferenceBackendDescription,
  textInferenceBackendDisplayName,
  textInferenceBackendTags,
  useTextInference,
} from '@/assets/js/store/textInference.ts'
import DeviceSelector from '@/components/DeviceSelector.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import AddLLMDialog from '@/components/AddLLMDialog.vue'
import { ref, computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n.ts'
import { useDemoMode } from '@/assets/js/store/demoMode.ts'
import Rag from '@/components/Rag.vue'
import { llmBackendTypes } from '@/types/shared.ts'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { useGlobalSetup } from '@/assets/js/store/globalSetup.ts'
import DropDownNew from '@/components/DropDownNew.vue'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets.ts'
import { useTextInferencePresets } from '@/assets/js/store/textInferencePresets.ts'
import PresetSelector from '@/components/PresetSelector.vue'
import MicrophoneSelector from "@/components/MicrophoneSelector.vue"

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
const textInferencePresets = useTextInferencePresets()
const presetsStore = usePresets()
const demoMode = useDemoMode()
const backendServices = useBackendServices()
const backendInfos = computed(() => backendTypesToBackends())
const globalSetup = useGlobalSetup()
const warningDialogStore = useDialogStore()

const currentPreset = computed(() => {
  if (!presetsStore.activePresetName) return null
  const preset = presetsStore.presets.find((p) => p.name === presetsStore.activePresetName)
  if (preset && preset.type === 'chat') return preset as ChatPreset
  return null
})

function handlePresetChange(presetName: string) {
  const preset = presetsStore.chatPresets.find((p) => p.name === presetName)
  if (preset) {
    handlePresetSelectionClick(preset)
  }
}

function handleVariantChange(presetName: string, variantName: string | null) {
  presetsStore.setActiveVariant(presetName, variantName)
}

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

async function handlePresetSelectionClick(preset: ChatPreset) {
  if (isBackendRunning(preset.backend)) {
    // Update active preset name in unified store
    presetsStore.activePresetName = preset.name

    // Apply the preset using textInference store
    await textInferencePresets.applyPreset(preset)
  } else {
    warningDialogStore.showWarningDialog(i18nState.SETTINGS_MODEL_REQUIREMENTS_NOT_MET, () => {
      globalSetup.loadingState = 'manageInstallations'
    })
  }
}

function isBackendRunning(backend: LlmBackend): boolean {
  const serviceName = mapBackendNames(backend)
  return backendServices.info.find((item) => item.serviceName === serviceName)?.status === 'running'
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
    .forEach((llmBackend) => {
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
