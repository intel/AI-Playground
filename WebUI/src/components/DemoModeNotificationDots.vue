<template>
  <template v-if="demoMode.enabled">
    <DemoModeNotificationDot
      v-for="buttonId in demoMode.notificationDotButtonIds"
      :key="buttonId"
      :target-id="buttonId"
    />
  </template>
</template>

<script setup lang="ts">
import { useDemoMode } from '@/assets/js/store/demoMode'
import DemoModeNotificationDot from '@/components/DemoModeNotificationDot.vue'

const demoMode = useDemoMode()
</script>
