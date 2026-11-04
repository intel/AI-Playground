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
         another mode would override that mode's selection. Every other mode's settings live in
         the session tabs (ModeSettingsTab). -->
    <SettingsAgent v-if="props.mode == 'agent'" />
  </SideModalBase>
</template>

<script setup lang="ts">
import { useModeSettingsLabel } from '@/assets/js/modeSettingsLabel'
import SideModalBase from '@/components/SideModalBase.vue'
import SettingsAgent from '@/components/SettingsAgent.vue'

const props = defineProps<{
  mode: ModeType
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()

const title = useModeSettingsLabel(() => props.mode)
</script>
