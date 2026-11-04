<template>
  <!-- A saved Agent Preset is bound to its Agent, whose save bar is in Schedules. -->
  <template v-if="agentMode.sessionScoped">
    <div
      v-if="!agentTasks.presetAgent"
      class="border-t border-border pt-4 flex flex-wrap items-center gap-2"
    >
      <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="saveAsDefault">
        {{ named(languages.SESSION_SETTINGS_SAVE_AS_DEFAULT_NAMED) }}
      </Button>
      <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="resetToDefault">
        {{ named(languages.SESSION_SETTINGS_RESET_TO_DEFAULT_NAMED) }}
      </Button>
    </div>
  </template>
  <div v-else class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
    <button class="mt-4" @click="resetPresetSettings">
      <div class="svg-icon i-refresh">Reset</div>
      {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useTextInference } from '@/assets/js/store/textInference'
import { Button } from '@/components/ui/button'
import * as toast from '@/assets/js/toast'

const emit = defineEmits<{ reset: [] }>()

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const textInference = useTextInference()
const oemBranding = useOemBranding()
const languages = useI18N().state

function named(template: string) {
  return template.replace('{preset}', oemBranding.presetLabel(agentMode.agentPresetName ?? ''))
}

function saveAsDefault() {
  agentMode.saveAsDefault()
  toast.success(languages.AGENT_SAVED_AS_DEFAULT)
}

function resetToDefault() {
  agentMode.resetToDefault()
  emit('reset')
  toast.success(languages.AGENT_RESET_TO_DEFAULT_DONE)
}

// The workspace folder, its sandbox consent and the sessions are the user's, so they survive.
function resetPresetSettings() {
  textInference.resetActivePresetSettings()
  agentMode.resetPresetSettings()
  emit('reset')
  toast.success('Reset to preset defaults')
}
</script>
