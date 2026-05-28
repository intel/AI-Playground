<template>
  <div class="relative">
    <slot />
    <div
      v-if="isBlocked"
      class="absolute inset-0 z-50 bg-transparent cursor-not-allowed"
      @click.stop.prevent="showBlockedToast"
      @mousedown.stop.prevent
      @pointerdown.stop.prevent
      tabindex="0"
      :aria-label="i18nState.DEMO_BLOCK_ARIA"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useI18N } from '@/assets/js/store/i18n'
import * as toast from '@/assets/js/toast'

const demoMode = useDemoMode()
const i18nState = useI18N().state
const isBlocked = computed(() => demoMode.enabled)

function showBlockedToast() {
  toast.show(i18nState.DEMO_BLOCK_TOAST)
}
</script>
