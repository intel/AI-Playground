<template>
  <SideModalBase
    :is-visible="isVisible"
    title="App Settings"
    side="left"
    @close="$emit('close')"
  >
    App Settings Here
  </SideModalBase>
</template>

<script setup lang="ts">
import SideModalBase from "@/components/SideModalBase.vue"

defineProps<{
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()
</script>
