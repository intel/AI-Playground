<template>
  <SettingsTabLayout
    :read-only="readOnly"
    :read-only-note="languages.AGENT_TASK_SESSION_SETTINGS_READ_ONLY"
    @reset="onPresetReset"
  >
    <!-- Agent Presets are chat presets, so this is also the way back to a plain chat preset. -->
    <template #picker>
      <PresetSelector
        type="chat"
        :model-value="presetsStore.activePresetName || undefined"
        @update:model-value="handlePresetChange"
      />
    </template>

    <SettingsRow :class="problemClass('backend')" :label="languages.AGENT_SETTING_BACKEND">
      <drop-down-new
        :title="languages.AGENT_SETTINGS_SELECT_BACKEND"
        :value="binding.backend"
        :items="binding.backendItems"
        @change="binding.setBackend"
      ></drop-down-new>
    </SettingsRow>
    <SettingsRow
      v-if="binding.backend === 'cloud'"
      :class="problemClass('cloudProvider')"
      :label="languages.AGENT_SETTING_PROVIDER"
    >
      <ProviderSelector />
    </SettingsRow>
    <!-- The picker's trigger is named after the selected model, so the row carries the
         stable name saying what the control is for. -->
    <SettingsRow
      role="group"
      :aria-label="languages.MODEL"
      :class="problemClass('model')"
      :label="languages.MODEL"
    >
      <div class="flex items-center gap-2 min-w-0">
        <div class="flex-1 min-w-0">
          <!-- Same picker as Chat, so an Agent Preset's requirements filter the list here too. -->
          <ModelSelector auto-select />
        </div>
        <CapabilityIcons v-if="binding.currentModel" :model="binding.currentModel" />
      </div>
    </SettingsRow>
    <SettingsRow
      v-if="binding.contextSizeSupported"
      :label="languages.ANSWER_CONTEXT_SIZE"
      label-for="agent-context-size"
    >
      <div class="flex items-center gap-3">
        <input
          id="agent-context-size"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          :value="contextSizeField.draft"
          class="rounded-sm text-foreground text-center h-[30px] w-24 leading-[30px] p-0 bg-transparent border border-border disabled:opacity-50"
          @focus="contextSizeField.onFocus"
          @input="contextSizeField.onInput"
          @blur="contextSizeField.commit"
          @keydown.enter="contextSizeField.commit"
        />
        <span v-if="binding.contextSize < 16384" class="text-xs text-amber-500">
          {{ languages.AGENT_SETTINGS_CONTEXT_HINT }}
        </span>
      </div>
    </SettingsRow>
    <p v-if="binding.sharedWithChat" class="text-xs text-muted-foreground">
      {{ languages.AGENT_SETTINGS_SHARED_WITH_CHAT }}
    </p>

    <!-- Only models whose template honours enable_thinking can be told to stop, and only a
         session that thinks has anything to shorten. -->
    <div v-if="binding.thinkingToggleSupported" class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">{{ languages.AGENT_SETTINGS_THINKING }}</Label>
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :checked="binding.thinkingEnabled"
          @change="binding.setThinkingEnabled(!binding.thinkingEnabled)"
        />
        <span class="flex flex-col">
          <span class="text-foreground">{{ languages.AGENT_SETTINGS_THINK_BEFORE_ACTING }}</span>
          <span v-if="binding.sharedWithChat" class="text-xs text-muted-foreground">
            {{ languages.AGENT_SETTINGS_THINKING_SHARED }}
          </span>
        </span>
      </label>
      <label v-if="binding.planningPhaseSupported" class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :disabled="!binding.thinkingEnabled"
          :checked="binding.planningThinkingOnly"
          @change="binding.setPlanningThinkingOnly(!binding.planningThinkingOnly)"
        />
        <span class="flex flex-col">
          <span class="text-foreground" :class="{ 'opacity-50': !binding.thinkingEnabled }">
            {{ languages.AGENT_SETTINGS_PLANNING_ONLY }}
          </span>
          <span class="text-xs text-muted-foreground">
            {{ languages.AGENT_SETTINGS_PLANNING_ONLY_HINT }}
          </span>
        </span>
      </label>
    </div>

    <p class="text-xs text-amber-500">{{ languages.AGENT_SETTINGS_NEXT_TURN }}</p>

    <template v-if="binding.backend !== 'cloud'" #machine>
      <SettingsRow :label="languages.DEVICE">
        <DeviceSelector :backend="deviceServiceName" />
      </SettingsRow>
    </template>

    <template #reset-fallback>
      <AgentPresetDefaultsActions @reset="refreshCapabilityCatalog" />
    </template>
  </SettingsTabLayout>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Label } from '@/components/ui/label'
import { backendToService, useTextInference } from '@/assets/js/store/textInference'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useI18N } from '@/assets/js/store/i18n'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { usePresets } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import AgentPresetDefaultsActions from '@/components/AgentPresetDefaultsActions.vue'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import PresetSelector from '@/components/PresetSelector.vue'
import ProviderSelector from '@/components/ProviderSelector.vue'
import SettingsRow from '@/components/SettingsRow.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import { useAgentSettingsPanel } from '@/assets/js/agentSettingsPanel'
import { useContextSizeField } from '@/assets/js/contextSizeField'
import { useSettingsProblemMarks } from '@/assets/js/settingsProblemMarks'
import * as toast from '@/assets/js/toast'

const languages = useI18N().state
const textInference = useTextInference()
const agentMode = useAgentMode()
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const oemBranding = useOemBranding()

const { binding, refreshCapabilityCatalog, readOnly } = useAgentSettingsPanel()
const { problemClass } = useSettingsProblemMarks(() => binding.problems)

const contextSize = computed<number>({
  get: () => binding.contextSize,
  set: (value) => binding.setContextSize(value),
})
const contextSizeField = useContextSizeField(contextSize)

// Only rendered for local backends, so the fallback is inert.
const deviceServiceName = computed(
  () => backendToService[textInference.backend] ?? 'llamacpp-backend',
)

function onPresetReset() {
  agentMode.resetPresetSettings()
  void refreshCapabilityCatalog()
}

async function handlePresetChange(presetName: string) {
  const result = await presetSwitching.switchPreset(presetName)
  if (result.success) {
    toast.success(`Switched to ${oemBranding.presetLabel(presetName)}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}
</script>
