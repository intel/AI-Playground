<template>
  <span
    v-if="isDemoModeOn"
    class="inline-flex items-center rounded px-3 py-1.5 text-xs font-medium text-secondary-foreground border border-demo-accent"
  >
    {{ i18nState.DEMO_MODE_ACTIVE }}
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useI18N } from '@/assets/js/store/i18n'

const demoMode = useDemoMode()
const i18nState = useI18N().state

const isDemoModeOn = computed(() => demoMode.enabled)
</script>
