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
      <PresetSelector
        type="chat"
        :model-value="presetsStore.activePresetName || undefined"
        @update:model-value="handlePresetChange"
        @update:variant="handleVariantChange"
      />

      <div class="flex flex-col gap-4">
        <!-- Backend selector - only shown when multiple backends are available -->
        <div
          v-if="!isBackendLocked"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
        >
          <Label class="whitespace-nowrap">Backend</Label>
          <drop-down-new
            title="Select Backend"
            @change="handleBackendChange"
            :value="textInference.backend"
            :items="availableBackendItems"
          ></drop-down-new>
        </div>
        <div v-if="!lockDeviceToNpu" class="grid grid-cols-[120px_1fr] items-center gap-4">
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

        <!-- Add Documents button - only shown when RAG is enabled -->
        <Button
          v-if="enableRAG"
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
        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap"
            >Temperature: {{ textInference.temperature.toFixed(1) }}</Label
          >
          <Slider v-model="textInference.temperature" :min="0" :max="2" :step="0.1" />
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
          <Checkbox
            id="metrics"
            :model-value="textInference.metricsEnabled"
            @click="() => (textInference.metricsEnabled = !textInference.metricsEnabled)"
          />
        </div>
        <!-- Enable Tools toggle - only shown when preset has showTools enabled -->
        <div
          v-if="showTools && textInference.modelSupportsToolCalling"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
        >
          <Label class="whitespace-nowrap">Enable Tools</Label>
          <Checkbox
            id="tools"
            :model-value="textInference.toolsEnabled"
            @click="() => (textInference.toolsEnabled = !textInference.toolsEnabled)"
          />
        </div>

        <!-- Embeddings selector - only shown when RAG is enabled -->
        <div v-if="enableRAG" class="grid grid-cols-[120px_1fr] items-center gap-4">
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

        <!-- System Prompt - only shown in advanced mode -->
        <div v-if="advancedMode" class="grid grid-cols-[120px_1fr] items-start gap-4">
          <Label class="whitespace-nowrap pt-2">System Prompt</Label>
          <Textarea
            v-model="textInference.systemPrompt"
            placeholder="You are a helpful AI assistant."
            class="min-h-[100px] text-sm"
          />
        </div>

        <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
          <button class="mt-4" @click="textInference.resetActivePresetSettings">
            <div class="svg-icon i-refresh">Reset</div>
            {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
          </button>
        </div>

        <!-- todo: needs to actually do something-->
        <Button variant="secondary" class="max-w-md mx-auto px-3 py-1.5 rounded text-sm">
          Create New Preset</Button
        >
      </div>
      <rag v-if="showUploader" ref="ragPanel" @close="showUploader = false"></rag>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import {
  backendToService,
  LlmBackend,
  useTextInference,
  textInferenceBackendDisplayName,
} from '@/assets/js/store/textInference.ts'
import DeviceSelector from '@/components/DeviceSelector.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import AddLLMDialog from '@/components/AddLLMDialog.vue'
import { ref, computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n.ts'
import { useDemoMode } from '@/assets/js/store/demoMode.ts'
import Rag from '@/components/Rag.vue'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { useGlobalSetup } from '@/assets/js/store/globalSetup.ts'
import DropDownNew from '@/components/DropDownNew.vue'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets.ts'
import PresetSelector from '@/components/PresetSelector.vue'

const showModelRequestDialog = ref(false)
const showUploader = ref(false)
const processing = ref(false)
const i18nState = useI18N().state
const textInference = useTextInference()
const presetsStore = usePresets()
const demoMode = useDemoMode()
const backendServices = useBackendServices()
const globalSetup = useGlobalSetup()
const warningDialogStore = useDialogStore()

// Get the active chat preset
const activeChatPreset = computed(() => {
  const preset = presetsStore.activePresetWithVariant
  if (preset?.type === 'chat') return preset as ChatPreset
  return null
})

// Check if backend is locked (only one backend allowed)
const isBackendLocked = computed(() => {
  return activeChatPreset.value?.backends?.length === 1
})

// UI visibility flags from preset
const enableRAG = computed(() => activeChatPreset.value?.enableRAG ?? false)
const showTools = computed(() => activeChatPreset.value?.showTools ?? false)
const lockDeviceToNpu = computed(() => activeChatPreset.value?.lockDeviceToNpu ?? false)
const advancedMode = computed(() => activeChatPreset.value?.advancedMode ?? false)

// Get available backends from preset
const availableBackends = computed(() => {
  return activeChatPreset.value?.backends ?? (['llamaCPP', 'openVINO', 'ollama'] as LlmBackend[])
})

// Backend items for dropdown
const availableBackendItems = computed(() => {
  return availableBackends.value.map((backend) => ({
    label: textInferenceBackendDisplayName[backend] || backend,
    value: backend,
    active: isBackendRunning(backend),
  }))
})

// Handle backend change from dropdown
function handleBackendChange(newBackend: string) {
  textInference.backend = newBackend as LlmBackend
}

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
  return { total: totalDocs, enabled: enabledDocs }
})

async function handlePresetSelectionClick(preset: ChatPreset) {
  // Check if at least one of the allowed backends is running
  const hasRunningBackend = preset.backends.some((backend) => isBackendRunning(backend))

  if (hasRunningBackend) {
    // Update active preset name in unified store
    presetsStore.activePresetName = preset.name

    // Apply the preset using textInference store
    await textInference.applyPreset(preset)
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

function mapBackendNames(name: LlmBackend): BackendServiceName | undefined {
  if (name === 'llamaCPP') return 'llamacpp-backend'
  if (name === 'openVINO') return 'openvino-backend'
  if (name === 'ollama') return 'ollama-backend' as BackendServiceName
  return undefined
}
</script>
