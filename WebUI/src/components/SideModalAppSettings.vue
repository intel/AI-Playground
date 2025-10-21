<template>
  <SideModalBase
    :is-visible="isVisible"
    title="App Settings"
    side="left"
    @close="$emit('close')"
  >
    <SettingsBasic/>
  </SideModalBase>
</template>

<script setup lang="ts">
import SideModalBase from "@/components/SideModalBase.vue"
import SettingsBasic from "@/components/SettingsBasic.vue";

defineProps<{
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()
</script>
