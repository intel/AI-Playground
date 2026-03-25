<template>
  <span
    v-if="isDemoModeOn"
    class="inline-flex items-center rounded px-3 py-1.5 text-xs font-medium text-secondary-foreground border border-demo-accent"
  >
    Demo mode active.
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDemoMode } from '@/assets/js/store/demoMode'

const demoMode = useDemoMode()

const isDemoModeOn = computed(() => demoMode.enabled)
</script>
