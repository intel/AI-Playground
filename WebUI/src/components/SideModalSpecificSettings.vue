<template>
  <SideModalBase
    id="advanced-settings-sidebar"
    :is-visible="isVisible"
    :title="`${mapModeToLabel(mode)} Settings`"
    hide-header
    side="right"
    @close="$emit('close')"
  >
    <!-- v-if (not v-show): these panels all drive the same (chat-type) active
         preset, and SettingsChat's ModelSelector runs an auto-select watcher that
         force-switches the shared model selection to match the active chat preset's
         filters. Keeping one mounted while another mode is active would silently
         override that mode's selection. -->
    <SettingsChat v-if="props.mode == 'chat'" />
    <SettingsAudio v-else-if="props.mode == 'audio'" />
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
import SideModalBase from '@/components/SideModalBase.vue'
import SettingsChat from '@/components/SettingsChat.vue'
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
</script>
