<template>
  <div>
    <div class="flex flex-col gap-6 p-1">
      <PresetSelector
        type="chat"
        :categories="['chat']"
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
        <SettingsHeading class="text-amber-600 dark:text-amber-200"
          >Global Home Agent Settings</SettingsHeading
        >
        <p class="text-xs text-muted-foreground">
          The settings for this preset impact all Home Agent conversations. Please verify after
          changing them to ensure that you can still access AI Playground remotely.
        </p>
      </div>

      <div class="flex flex-col gap-4">
        <!-- Backend selector - only shown when multiple backends are available -->
        <SettingsRow v-if="!isBackendLocked" label="Backend">
          <drop-down-new
            title="Select Backend"
            @change="handleBackendChange"
            :value="textInference.backend"
            :items="availableBackendItems"
          ></drop-down-new>
        </SettingsRow>
        <!-- Cloud Mode swaps the hardware "Device" picker for a remote "Provider" picker. -->
        <SettingsRow v-if="textInference.backend === 'cloud'" label="Provider">
          <ProviderSelector />
        </SettingsRow>
        <SettingsRow v-else :label="languages.DEVICE">
          <DeviceSelector :backend="deviceServiceName" />
        </SettingsRow>
        <!-- The picker's trigger is named after whichever model is selected, so the
             row carries the stable name that identifies what the control is for. -->
        <SettingsRow role="group" :aria-label="languages.MODEL">
          <!-- The gear lives in the label column: managing models belongs to this
               row, but it must not eat into the width the picker needs to show a
               model name. -->
          <template #label>
            <div class="flex items-center justify-between gap-2">
              <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
              <SettingsButton
                class="shrink-0"
                :title="languages.MODEL_MANAGER_MANAGE"
                :aria-label="languages.MODEL_MANAGER_MANAGE"
                @click="uiStore.openModelManager()"
              />
            </div>
          </template>
          <div class="flex items-center gap-2 min-w-0">
            <div class="flex-1 min-w-0">
              <ModelSelector />
            </div>
            <CapabilityIcons v-if="currentModel" :model="currentModel" />
          </div>
        </SettingsRow>
        <!-- Two numbers that are read together (a reply cannot exceed either), so
             they share a row rather than stacking two mostly-empty ones. Each half
             is a row of its own, so the right-hand pair sits in its half exactly as
             the left one does. -->
        <div class="grid grid-cols-2 gap-4">
          <SettingsRow :label="languages.ANSWER_MAX_TOKENS" label-for="chat-max-tokens">
            <div class="flex flex-col gap-1">
              <input
                id="chat-max-tokens"
                type="number"
                v-model="textInference.maxTokens"
                min="0"
                max="32768"
                step="1"
                class="rounded-sm text-foreground text-center h-[30px] w-20 leading-[30px] p-0 bg-transparent border border-border"
              />
              <!-- The request is capped at what the window can hold whatever is typed
                   here (see `effectiveMaxTokens`); say so rather than letting the box
                   claim a number the model will never be asked for. -->
              <span
                v-if="textInference.effectiveMaxTokens < textInference.maxTokens"
                class="text-xs text-muted-foreground"
              >
                Capped to {{ textInference.effectiveMaxTokens }} by the model's context window.
              </span>
            </div>
          </SettingsRow>
          <SettingsRow
            v-if="textInference.contextSizeSettingSupported"
            :label="languages.ANSWER_CONTEXT_SIZE"
            label-for="chat-context-size"
          >
            <div class="flex flex-col gap-1">
              <input
                id="chat-context-size"
                type="number"
                v-model="textInference.contextSize"
                :min="textInference.enforceKmContextFloor ? PHISON_KM_CONTEXT_FLOOR : 512"
                max="131072"
                step="512"
                class="rounded-sm text-foreground text-center h-[30px] w-20 leading-[30px] p-0 bg-transparent border border-border"
              />
              <p v-if="textInference.enforceKmContextFloor" class="text-xs text-muted-foreground">
                {{ languages.PHISON_KM_CONTEXT_HINT }}
              </p>
            </div>
          </SettingsRow>
        </div>
        <SettingsRow :label="`Temperature: ${textInference.temperature.toFixed(1)}`">
          <Slider v-model="textInference.temperature" :min="0" :max="2" :step="0.1" />
        </SettingsRow>
        <SettingsRow v-if="showRetrievalModeToggle" :label="languages.RAG_RETRIEVAL_MODE">
          <div class="flex flex-col gap-1">
            <div
              class="inline-flex w-fit overflow-hidden rounded-md border border-border"
              :title="retrievalModeUnavailableReason"
            >
              <button
                type="button"
                class="h-[30px] px-3 text-sm transition-colors"
                :class="
                  effectiveRagMode === 'standard'
                    ? 'bg-primary text-foreground'
                    : 'bg-transparent hover:bg-primary/20'
                "
                @click="textInference.ragMode = 'standard'"
              >
                {{ languages.RAG_MODE_STANDARD }}
              </button>
              <button
                type="button"
                :disabled="disableRetrievalModeToggle"
                class="h-[30px] border-l border-border px-3 text-sm transition-colors"
                :class="[
                  effectiveRagMode === 'phisonKm'
                    ? 'bg-primary text-foreground'
                    : 'bg-transparent hover:bg-primary/20',
                  disableRetrievalModeToggle ? 'cursor-not-allowed opacity-50' : '',
                ]"
                @click="textInference.ragMode = 'phisonKm'"
              >
                {{ languages.RAG_MODE_PHISON_KM }}
              </button>
            </div>
            <p v-if="retrievalModeUnavailableReason" class="text-xs text-muted-foreground">
              {{ retrievalModeUnavailableReason }}
            </p>
          </div>
        </SettingsRow>
        <!-- Both are per-reply switches; the thinking one only exists for models
             whose template supports enable_thinking. Not the label/control grid:
             each box belongs to the word beside it, so the pair reads left to
             right instead of across two columns. `for` already forwards a label
             click to the checkbox (a button is a labelable element), so a handler
             here would toggle it twice. -->
        <!-- Kept at row height so a pair of 16px checkboxes doesn't read as a
             shorter band than the picker rows around it. -->
        <div class="flex min-h-[30px] items-center gap-2">
          <template v-if="textInference.modelSupportsThinkingToggle">
            <Label for="thinking" class="cursor-pointer whitespace-nowrap">Thinking</Label>
            <Checkbox
              id="thinking"
              :model-value="textInference.thinkingEnabled"
              @click="() => (textInference.thinkingEnabled = !textInference.thinkingEnabled)"
            />
          </template>
          <!-- The gap only exists when something precedes it, so on a model without
               the thinking toggle Metrics still starts at the label column. -->
          <Label
            for="metrics"
            class="cursor-pointer whitespace-nowrap"
            :class="{ 'ml-6': textInference.modelSupportsThinkingToggle }"
            >{{ languages.ANSWER_METRICS }}</Label
          >
          <Checkbox
            id="metrics"
            :model-value="textInference.metricsEnabled"
            @click="() => (textInference.metricsEnabled = !textInference.metricsEnabled)"
          />
        </div>
        <!-- How long the model reasons before answering. Only models whose
             template reads reasoning_effort (Qwen3.8) recommend one, and only a
             thinking turn has a trace to size. -->
        <SettingsRow
          v-if="textInference.modelSupportsReasoningEffort && textInference.thinkingActive"
          label="Reasoning effort"
        >
          <drop-down-new
            title="Reasoning effort"
            :value="textInference.effectiveReasoningEffort ?? ''"
            :items="reasoningEffortItems"
            @change="(value: string) => (textInference.reasoningEffort = value as ReasoningEffort)"
          ></drop-down-new>
        </SettingsRow>
        <!-- Retrieval belongs together: the embedding model is what the documents
             are indexed with, so the uploader opens from the same row. The button
             is an icon plus its count — a full label left the dropdown too narrow
             to read a model name in. -->
        <SettingsRow v-if="enableRAG" label="Embeddings">
          <!-- A grid, not a flex row: as a grid item the dropdown stretches to the
               space the button leaves, which a flex child of DropDownNew does not. -->
          <div class="grid grid-cols-[1fr_auto] items-center gap-2 min-w-0">
            <drop-down-new
              :title="languages.RAG_DOCUMENT_EMBEDDING_MODEL"
              @change="(item) => textInference.selectEmbeddingModel(textInference.backend, item)"
              :value="activeEmbeddingModelName"
              :items="embeddingModelItems"
            ></drop-down-new>
            <Button
              variant="secondary"
              class="h-[30px] shrink-0 gap-1.5 rounded px-2 text-sm"
              @click="showUploader = !showUploader"
              :disabled="processing"
              :title="documentButtonText"
              :aria-label="documentButtonText"
            >
              <DocumentTextIcon class="size-4" />
              <span v-if="documentStats.total > 0" class="text-xs">
                {{ documentStats.enabled }}
              </span>
              <PlusIcon v-else class="size-3" />
            </Button>
          </div>
        </SettingsRow>

        <!-- Each panel carries its own master switch in its header: the toggle and
             what it governs are one block, which is two fewer label rows than
             floating the switches above the panels. Tools need a tool-calling
             model, so the header explains itself when the model has none. -->
        <template v-if="showTools">
          <SettingsBuiltinTools />
          <SettingsMcp />
        </template>

        <!-- System Prompt - only shown in advanced mode. Top-aligned: the textarea
             is several rows tall and its label belongs beside its first line. -->
        <SettingsRow v-if="advancedMode" align="start">
          <template #label>
            <Label for="chat-system-prompt" class="whitespace-nowrap pt-2">System Prompt</Label>
          </template>
          <Textarea
            id="chat-system-prompt"
            v-model="textInference.systemPrompt"
            placeholder="You are a helpful AI assistant."
            class="min-h-[100px] text-sm"
          />
        </SettingsRow>

        <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
          <button class="mt-4" @click="textInference.resetActivePresetSettings">
            <div class="svg-icon i-refresh">Reset</div>
            {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
          </button>
        </div>
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
import ProviderSelector from '@/components/ProviderSelector.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import SettingsButton from '@/components/SettingsButton.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import SettingsRow from '@/components/SettingsRow.vue'
import { DocumentTextIcon, PlusIcon } from '@heroicons/vue/24/solid'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import { ref, computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n.ts'
import Rag from '@/components/Rag.vue'
import SettingsMcp from '@/components/SettingsMcp.vue'
import SettingsBuiltinTools from '@/components/SettingsBuiltinTools.vue'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import DropDownNew from '@/components/DropDownNew.vue'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets.ts'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching.ts'
import PresetSelector from '@/components/PresetSelector.vue'
import * as toast from '@/assets/js/toast'
import { useProductMode } from '@/assets/js/store/productMode'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'
import { PHISON_KM_CONTEXT_FLOOR } from '@/assets/js/phisonKmRag'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { reasoningEfforts, type ReasoningEffort } from '@/types/shared'
import { sortFavoritesFirst } from '@/assets/js/models/favorites'
import { useUIStore } from '@/assets/js/store/ui'

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
const cloudMode = useCloudMode()
const uiStore = useUIStore()

// Non-null service name for the local-backend DeviceSelector (only rendered for
// non-cloud backends; cloud uses ProviderSelector instead).
const deviceServiceName = computed(
  () => backendToService[textInference.backend] ?? 'llamacpp-backend',
)

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

// Active model (capabilities) for the icon row next to the selector — same
// source as ModelSelector / PromptStatusBar.
const currentModel = computed(() =>
  textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
)

const activeEmbeddingModelName = computed(
  () =>
    textInference.llmEmbeddingModels
      .filter((m) => m.type === textInference.backend)
      .find((m) => m.active)?.name ?? '',
)

// Same treatment as the chat model picker: favorites float to the top.
const embeddingModelItems = computed(() =>
  sortFavoritesFirst(
    textInference.llmEmbeddingModels.filter((m) => m.type === textInference.backend),
  ).map((item) => ({
    label: item.name.split('/').at(-1) ?? item.name,
    value: item.name,
    active: item.downloaded,
  })),
)

// UI visibility flags from preset
const enableRAG = computed(() => activeChatPreset.value?.enableRAG ?? false)
const showTools = computed(() => activeChatPreset.value?.showTools ?? false)
const showRetrievalModeToggle = computed(
  () =>
    enableRAG.value &&
    activeChatPreset.value?.supportsPhisonKmRag === true &&
    activeChatPreset.value?.requiresPhison !== true &&
    textInference.phisonSsdPresent,
)
const disableRetrievalModeToggle = computed(() => !textInference.phisonKmAvailable)
const effectiveRagMode = computed(() => (textInference.isPhisonKmRag ? 'phisonKm' : 'standard'))
const retrievalModeUnavailableReason = computed(() => {
  if (textInference.phisonKmAvailable) return ''
  return textInference.kmContextFloorReachable
    ? i18nState.PHISON_KM_UNAVAILABLE_BUILD_HINT
    : i18nState.PHISON_KM_UNAVAILABLE_CONTEXT_HINT
})
const advancedMode = computed(() => activeChatPreset.value?.advancedMode ?? false)

// Get available backends from preset (fallback when none configured on preset)
const availableBackends = computed(() => {
  let base = activeChatPreset.value?.backends ?? (['llamaCPP', 'openVINO'] as LlmBackend[])
  if (productModeStore.productMode === 'nvidia') {
    base = base.filter((b) => b !== 'openVINO')
  }
  // Surface Cloud Mode as a selectable backend whenever the feature is enabled.
  if (cloudMode.isFeatureEnabled && !base.includes('cloud')) {
    base = [...base, 'cloud']
  }
  return base
})

// Reasoning-effort choices, cheapest first. The one the model recommends is
// marked active so the dropdown shows where the default came from.
const reasoningEffortItems = computed(() =>
  reasoningEfforts.map((effort) => ({
    label: effort,
    value: effort,
    active: effort === textInference.effectiveReasoningEffort,
  })),
)

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
  // Switching to Cloud Mode refreshes the selected provider's model list
  // (overwriting it on success) so the picker reflects the live provider state.
  if (newBackend === 'cloud') {
    cloudMode.refreshSelectedProviderModels()
  }
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

  // The mode follows the preset: an agent preset in this list switches the app to
  // Agent Mode, so the switch is not told to stay put.
  const result = await presetSwitching.switchPreset(presetName)

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
  // Cloud Mode has no local service — it's "ready" once a provider base URL
  // is configured.
  if (backend === 'cloud') return !!cloudMode.activeProviderBaseUrl
  const serviceName = backendToService[backend]
  return backendServices.info.find((item) => item.serviceName === serviceName)?.status === 'running'
}
</script>
