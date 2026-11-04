<template>
  <SettingsTabLayout :machine-only="isHomeAgentPresetActive" :machine-note="machineNote">
    <template #picker>
      <PresetSelector
        type="chat"
        :categories="['chat']"
        :model-value="presetsStore.activePresetName || undefined"
        @update:model-value="handlePresetChange"
        @update:variant="handleVariantChange"
      />
    </template>

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
          <ModelSelector auto-select />
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
            type="text"
            inputmode="numeric"
            autocomplete="off"
            :value="contextSizeField.draft"
            class="rounded-sm text-foreground text-center h-[30px] w-24 leading-[30px] p-0 bg-transparent border border-border"
            @focus="contextSizeField.onFocus"
            @input="contextSizeField.onInput"
            @blur="contextSizeField.commit"
            @keydown.enter="contextSizeField.commit"
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
    <SettingsRow
      v-if="textInference.modelSupportsMtp"
      label="Draft tokens (MTP)"
      label-for="chat-mtp-assistant-tokens"
    >
      <input
        id="chat-mtp-assistant-tokens"
        type="number"
        v-model.number="textInference.numAssistantTokens"
        :min="OVMS_MTP_ASSISTANT_TOKENS_MIN"
        :max="OVMS_MTP_ASSISTANT_TOKENS_MAX"
        step="1"
        class="rounded-sm text-foreground text-center h-[30px] w-20 leading-[30px] p-0 bg-transparent border border-border"
      />
    </SettingsRow>
    <!-- Both are per-reply switches; the thinking one only exists for models
         whose template supports enable_thinking. Not the label/control grid:
         each box belongs to the word beside it, so the pair reads left to
         right instead of across two columns. `for` already forwards a label
         click to the checkbox (a button is a labelable element), so a handler
         here would toggle it twice. Kept at row height so a pair of 16px
         checkboxes doesn't read as a shorter band than the picker rows. -->
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

    <template v-if="textInference.backend !== 'cloud'" #machine>
      <SettingsRow :label="languages.DEVICE">
        <DeviceSelector :backend="deviceServiceName" />
      </SettingsRow>
    </template>

    <template #reset-fallback>
      <ChatPresetResetButton />
    </template>
  </SettingsTabLayout>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  backendToService,
  LlmBackend,
  useTextInference,
  textInferenceBackendDisplayName,
} from '@/assets/js/store/textInference.ts'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { usePresets } from '@/assets/js/store/presets.ts'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching.ts'
import { useProductMode } from '@/assets/js/store/productMode'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'
import { useSessionChat } from '@/assets/js/store/sessionChat'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useUIStore } from '@/assets/js/store/ui'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useI18N } from '@/assets/js/store/i18n'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import ChatPresetResetButton from '@/components/ChatPresetResetButton.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import PresetSelector from '@/components/PresetSelector.vue'
import ProviderSelector from '@/components/ProviderSelector.vue'
import SettingsButton from '@/components/SettingsButton.vue'
import SettingsRow from '@/components/SettingsRow.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import { useActiveChatPreset } from '@/assets/js/activeChatPreset'
import { useContextSizeField } from '@/assets/js/contextSizeField'
import * as toast from '@/assets/js/toast'
import { OVMS_MTP_ASSISTANT_TOKENS_MAX, OVMS_MTP_ASSISTANT_TOKENS_MIN } from '@/lib/ovmsMtp'
import { reasoningEfforts, type ReasoningEffort } from '@/types/shared'

const languages = useI18N().state
const textInference = useTextInference()
const contextSizeField = useContextSizeField(toRef(textInference, 'contextSize'), () =>
  textInference.markContextSizeEdited(),
)
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const backendServices = useBackendServices()
const productModeStore = useProductMode()
const conversations = useConversations()
const sessionChat = useSessionChat()
const homeAgent = useHomeAgent()
const cloudMode = useCloudMode()
const uiStore = useUIStore()
const oemBranding = useOemBranding()

const { activeChatPreset, isHomeAgentPresetActive, machineNote } = useActiveChatPreset()

// Non-null service name for the local-backend DeviceSelector (only rendered for
// non-cloud backends; cloud uses ProviderSelector instead).
const deviceServiceName = computed(
  () => backendToService[textInference.backend] ?? 'llamacpp-backend',
)

const isBackendLocked = computed(() => activeChatPreset.value?.backends?.length === 1)

// Active model (capabilities) for the icon row next to the selector — same
// source as ModelSelector / PromptStatusBar.
const currentModel = computed(() =>
  textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
)

const availableBackends = computed(() => {
  let base = activeChatPreset.value?.backends ?? (['llamaCPP', 'openVINO'] as LlmBackend[])
  if (productModeStore.productMode === 'nvidia') {
    base = base.filter((b) => b !== 'openVINO')
  }
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

const availableBackendItems = computed(() =>
  availableBackends.value.map((backend) => ({
    label: textInferenceBackendDisplayName[backend] || backend,
    value: backend,
    active: isBackendRunning(backend),
  })),
)

function handleBackendChange(newBackend: string) {
  textInference.backend = newBackend as LlmBackend
  // Switching to Cloud Mode refreshes the selected provider's model list
  // (overwriting it on success) so the picker reflects the live provider state.
  if (newBackend === 'cloud') {
    cloudMode.refreshSelectedProviderModels()
  }
}

async function handlePresetChange(presetName: string) {
  // Picking Home Agent jumps to the most recently routed Home Agent thread, so the
  // remote bridge and this view share one conversation; picking another preset off a
  // Home Agent thread returns to the Session instead of writing into Home Agent state.
  const switchingToHomeAgent = presetName === HOME_AGENT_CHAT_PRESET_NAME
  const onHomeAgentThread = conversations.getThreadKind(conversations.activeKey) === 'homeAgent'

  // The mode follows the preset: an agent preset in this list switches the app to
  // Agent Mode, so the switch is not told to stay put.
  const result = await presetSwitching.switchPreset(presetName)

  if (result.success) {
    // Only reroute once the switch succeeded, or a failed switch would leave the view
    // on another thread while the picker stayed on the previous preset.
    if (switchingToHomeAgent) {
      conversations.activeKey = homeAgent.ensureActiveRemoteConversation()
    } else if (onHomeAgentThread) {
      sessionChat.returnToSessionChat()
    }
    toast.success(`Switched to ${oemBranding.presetLabel(presetName)}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}

async function handleVariantChange(presetName: string, variantName: string | null) {
  if (!variantName) return
  const result = await presetSwitching.switchPreset(presetName, {
    variant: variantName,
    skipModeSwitch: true,
  })
  if (!result.success && result.error) {
    toast.error(`Failed to switch variant: ${result.error}`)
  }
}

function isBackendRunning(backend: LlmBackend): boolean {
  // Cloud Mode has no local service — it's "ready" once a provider base URL is configured.
  if (backend === 'cloud') return !!cloudMode.activeProviderBaseUrl
  const serviceName = backendToService[backend]
  return backendServices.info.find((item) => item.serviceName === serviceName)?.status === 'running'
}
</script>
