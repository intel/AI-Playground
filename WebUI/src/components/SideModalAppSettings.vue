<template>
  <SideModalBase
    :is-visible="isVisible"
    title="App Settings"
    side="left"
    @close="$emit('close')"
  >
    <SettingsApp/>
  </SideModalBase>
</template>

<script setup lang="ts">
import SideModalBase from "@/components/SideModalBase.vue"
import SettingsApp from "@/components/SettingsApp.vue";

defineProps<{
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()
</script>
