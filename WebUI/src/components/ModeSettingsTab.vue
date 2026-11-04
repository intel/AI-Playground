<template>
  <!-- v-if per mode: the chat ModelSelector auto-selects for the active chat-type preset,
       so a copy left mounted under another mode would override that mode's model. -->
  <template v-if="mode === 'chat'">
    <SettingsChatInferencing v-if="tab === 'inferencing'" />
    <SettingsChatAttributes v-else />
  </template>
  <template v-else-if="mode === 'agent'">
    <SettingsAgentInferencing v-if="tab === 'inferencing'" />
    <SettingsAgentAttributes v-else />
  </template>
  <template v-else-if="mode === 'imageGen' || mode === 'imageEdit' || mode === 'video'">
    <SettingsWorkflowInferencing
      v-if="tab === 'inferencing'"
      :key="mode"
      :categories="[WORKFLOW_CATEGORIES[mode]]"
    />
    <SettingsWorkflowAttributes v-else :key="mode" />
  </template>
  <template v-else-if="mode === 'audio'">
    <SettingsAudioInferencing v-if="tab === 'inferencing'" />
    <SettingsAudioAttributes v-else />
  </template>
</template>

<script setup lang="ts">
import SettingsAgentAttributes from '@/components/SettingsAgentAttributes.vue'
import SettingsAgentInferencing from '@/components/SettingsAgentInferencing.vue'
import SettingsAudioAttributes from '@/components/SettingsAudioAttributes.vue'
import SettingsAudioInferencing from '@/components/SettingsAudioInferencing.vue'
import SettingsChatAttributes from '@/components/SettingsChatAttributes.vue'
import SettingsChatInferencing from '@/components/SettingsChatInferencing.vue'
import SettingsWorkflowAttributes from '@/components/SettingsWorkflowAttributes.vue'
import SettingsWorkflowInferencing from '@/components/SettingsWorkflowInferencing.vue'

const WORKFLOW_CATEGORIES: Record<'imageGen' | 'imageEdit' | 'video', string> = {
  imageGen: 'create-images',
  imageEdit: 'edit-images',
  video: 'create-videos',
}

defineProps<{
  mode: ModeType
  tab: 'inferencing' | 'attributes'
}>()
</script>
