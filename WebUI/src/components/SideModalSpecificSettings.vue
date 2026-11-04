<template>
  <SideModalBase
    id="advanced-settings-sidebar"
    :is-visible="isVisible"
    :title="title"
    hide-header
    side="right"
    @close="$emit('close')"
  >
    <!-- Every mode's settings live in the session tabs (ModeSettingsTab). -->
  </SideModalBase>
</template>

<script setup lang="ts">
import { useModeSettingsLabel } from '@/assets/js/modeSettingsLabel'
import SideModalBase from '@/components/SideModalBase.vue'

const props = defineProps<{
  mode: ModeType
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()

const title = useModeSettingsLabel(() => props.mode)
</script>
