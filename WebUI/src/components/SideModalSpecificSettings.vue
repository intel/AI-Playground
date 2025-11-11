<template>
  <SideModalBase
    :is-visible="isVisible"
    :title="`${mapModeToLabel(mode)} Settings`"
    side="right"
    @close="$emit('close')"
  >
    <SettingsChat v-show="props.mode == 'chat'" />
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
