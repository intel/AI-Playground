<template>
  <!-- v-if per mode: the chat ModelSelector auto-selects for the active chat-type preset,
       so a copy left mounted under another mode would override that mode's model. -->
  <template v-if="mode === 'chat'">
    <SettingsChatInferencing v-if="tab === 'inferencing'" />
    <SettingsChatAttributes v-else />
  </template>
</template>

<script setup lang="ts">
import SettingsChatAttributes from '@/components/SettingsChatAttributes.vue'
import SettingsChatInferencing from '@/components/SettingsChatInferencing.vue'

defineProps<{
  mode: ModeType
  tab: 'inferencing' | 'attributes'
}>()
</script>
