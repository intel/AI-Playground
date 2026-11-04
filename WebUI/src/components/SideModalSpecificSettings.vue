<template>
  <SideModalBase
    id="advanced-settings-sidebar"
    :is-visible="isVisible"
    :title="title"
    hide-header
    side="right"
    @close="$emit('close')"
  >
    <!-- v-if (not v-show): these panels drive the same (chat-type) active preset, and
         the agent form's ModelSelector auto-selects for it, so one left mounted under
         another mode would override that mode's selection. Chat settings live in the
         session tabs (ModeSettingsTab). -->
    <SettingsAudio v-if="props.mode == 'audio'" />
    <SettingsAgent v-else-if="props.mode == 'agent'" />
    <SettingsWorkflow
      v-show="props.mode == 'imageGen'"
      :categories="['create-images']"
      :title="`${mapModeToLabel(mode)} Presets`"
    />
    <SettingsWorkflow
      v-show="props.mode == 'imageEdit'"
      :categories="['edit-images']"
      :title="`${mapModeToLabel(mode)} Presets`"
    />
    <SettingsWorkflow
      v-show="props.mode == 'video'"
      :categories="['create-videos']"
      :title="`${mapModeToLabel(mode)} Presets`"
    />
  </SideModalBase>
</template>

<script setup lang="ts">
import { useModeSettingsLabel } from '@/assets/js/modeSettingsLabel'
import SideModalBase from '@/components/SideModalBase.vue'
import SettingsAgent from '@/components/SettingsAgent.vue'
import SettingsAudio from '@/components/SettingsAudio.vue'
import SettingsWorkflow from '@/components/SettingsWorkflow.vue'
import { mapModeToLabel } from '@/lib/utils.ts'

const props = defineProps<{
  mode: ModeType
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()

const title = useModeSettingsLabel(() => props.mode)
</script>
