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
      aria-label="Demo mode block overlay"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDemoMode } from '@/assets/js/store/demoMode'
import * as toast from '@/assets/js/toast'

const demoMode = useDemoMode()
const isBlocked = computed(() => demoMode.enabled)

function showBlockedToast() {
  toast.show('Clicking this feature is disabled during demo.')
}
</script>
