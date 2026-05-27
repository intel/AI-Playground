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

      <!-- When the Home Agent preset is the active chat preset, surface a
           global-settings warning. These knobs apply to every Home Agent
           conversation (Telegram + desktop), so changes can lock the user
           out of remote access if not verified. -->
      <div
        v-if="isHomeAgentPresetActive"
        class="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-foreground"
      >
        <p class="font-semibold text-amber-600 dark:text-amber-200">Global Home Agent Settings</p>
        <p class="text-xs text-muted-foreground">
          The settings for this preset impact all Home Agent conversations. Please verify after
          changing them to ensure that you can still access AI Playground remotely.
        </p>
      </div>

      <div class="flex flex-col gap-4">
        <!-- Backend selector - only shown when multiple backends are available -->
        <div v-if="!isBackendLocked" class="grid grid-cols-[120px_1fr] items-center gap-4">
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
        <!-- Built-in Tools toggle - only shown when preset has showTools enabled -->
        <div
          v-if="showTools && textInference.modelSupportsToolCalling"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
        >
          <Label class="whitespace-nowrap">Built-in tools:</Label>
          <Checkbox
            id="tools"
            :model-value="textInference.aipgToolsEnabled"
            @click="() => (textInference.aipgToolsEnabled = !textInference.aipgToolsEnabled)"
          />
        </div>

        <!-- MCP Tools toggle -->
        <div
          v-if="showTools && textInference.modelSupportsToolCalling"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
        >
          <Label class="whitespace-nowrap">MCP tools:</Label>
          <Checkbox
            id="mcp-tools"
            :model-value="textInference.mcpToolsEnabled"
            @click="() => (textInference.mcpToolsEnabled = !textInference.mcpToolsEnabled)"
          />
        </div>

        <div
          v-if="showTools && textInference.modelSupportsToolCalling"
          class="pl-2 pt-2"
          :class="{ 'opacity-50': !textInference.mcpToolsEnabled }"
        >
          <SettingsMcp />
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
import Rag from '@/components/Rag.vue'
import SettingsMcp from '@/components/SettingsMcp.vue'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import DropDownNew from '@/components/DropDownNew.vue'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets.ts'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching.ts'
import PresetSelector from '@/components/PresetSelector.vue'
import * as toast from '@/assets/js/toast'
import { useProductMode } from '@/assets/js/store/productMode'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'
import { useHomeAgent } from '@/assets/js/store/homeAgent'

const showModelRequestDialog = ref(false)
const showUploader = ref(false)
const processing = ref(false)
const i18nState = useI18N().state
const textInference = useTextInference()
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const backendServices = useBackendServices()
const productModeStore = useProductMode()
const conversations = useConversations()
const homeAgent = useHomeAgent()

const isHomeAgentPresetActive = computed(
  () => presetsStore.activePresetName === HOME_AGENT_CHAT_PRESET_NAME,
)

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

// Get available backends from preset (fallback when none configured on preset)
const availableBackends = computed(() => {
  const base = activeChatPreset.value?.backends ?? (['llamaCPP', 'openVINO'] as LlmBackend[])
  if (productModeStore.productMode === 'nvidia') {
    return base.filter((b) => b !== 'openVINO')
  }
  return base
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

async function handlePresetChange(presetName: string) {
  // Route the active conversation alongside the preset:
  //   • picking Home Agent jumps to the most-recently routed Home Agent thread
  //     (so the Telegram bridge and this view share the same conversation)
  //   • picking any other chat preset off a Home Agent thread spawns a fresh
  //     main conversation so the user isn't writing into Home Agent state
  //     with a non-Home-Agent preset.
  const switchingToHomeAgent = presetName === HOME_AGENT_CHAT_PRESET_NAME
  const onHomeAgentThread = conversations.getThreadKind(conversations.activeKey) === 'homeAgent'

  const result = await presetSwitching.switchPreset(presetName, {
    skipModeSwitch: true, // We're already in chat mode
  })

  if (result.success) {
    // Only reroute the conversation after the preset switch actually succeeds —
    // otherwise a failed switch would leave the UI on a different thread while
    // the picker stayed on the previous preset.
    if (switchingToHomeAgent) {
      conversations.activeKey = homeAgent.ensureActiveRemoteConversation()
    } else if (onHomeAgentThread) {
      conversations.addNewConversation()
    }
    toast.success(`Switched to ${presetName}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}

async function handleVariantChange(presetName: string, variantName: string | null) {
  if (variantName) {
    const result = await presetSwitching.switchPreset(presetName, {
      variant: variantName,
      skipModeSwitch: true,
    })

    if (!result.success && result.error) {
      toast.error(`Failed to switch variant: ${result.error}`)
    }
  }
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

function isBackendRunning(backend: LlmBackend): boolean {
  const serviceName = backendToService[backend]
  return backendServices.info.find((item) => item.serviceName === serviceName)?.status === 'running'
}
</script>
