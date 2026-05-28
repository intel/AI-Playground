<template>
  <SideModalBase
    id="app-settings-sidebar"
    :is-visible="isVisible"
    :title="i18nState.COM_APP_SETTINGS"
    side="left"
    @close="$emit('close')"
  >
    <SettingsBasic />
  </SideModalBase>
</template>

<script setup lang="ts">
import SideModalBase from '@/components/SideModalBase.vue'
import SettingsBasic from '@/components/SettingsBasic.vue'
import { useI18N } from '@/assets/js/store/i18n'

const i18nState = useI18N().state

defineProps<{
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()
</script>
