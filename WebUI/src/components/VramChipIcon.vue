<script setup lang="ts">
import { useId } from 'vue'
import type { VramFitBars, VramFitVerdict } from '@/lib/vram'

// The defaults draw the plain "fits" chip, so the size filter can take the component as is.
withDefaults(defineProps<{ verdict?: VramFitVerdict; bars?: VramFitBars }>(), {
  verdict: 'easy',
  bars: 1,
})

const PINS =
  'M9.5 2.75v2.25M14.5 2.75v2.25M9.5 19v2.25M14.5 19v2.25M2.75 9.5H5M2.75 14.5H5M19 9.5h2.25M19 14.5h2.25'
const BODY = 'M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z'

// Green while the model fits, gold when the gauge is full. The frame stays the text color.
const EASY_BAR = '#439921'
const TIGHT_BAR = '#e1ad30'

// Several icons share one document, so each cutout needs its own mask id.
const maskId = `vram-chip-${useId()}`
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="PINS" />
    <template v-if="verdict === 'over'">
      <mask :id="maskId">
        <rect width="24" height="24" fill="white" stroke="none" />
        <path d="M12 8.25v4.25" stroke="black" stroke-width="2" />
        <circle cx="12" cy="15.6" r="1.1" fill="black" stroke="none" />
      </mask>
      <path :d="BODY" fill="currentColor" :mask="`url(#${maskId})`" />
    </template>
    <template v-else>
      <path :d="BODY" />
      <template v-if="verdict === 'unknown'">
        <path d="M10 9.7a2 2 0 1 1 2.7 1.87c-.43.17-.7.57-.7 1.03v.4" />
        <circle cx="12" cy="15.6" r="0.9" fill="currentColor" stroke="none" />
      </template>
      <rect
        v-for="i in bars"
        v-else
        :key="i"
        :x="7.9 + (i - 1) * 3"
        y="8"
        width="2.2"
        height="8"
        rx="0.5"
        :fill="bars === 3 ? TIGHT_BAR : EASY_BAR"
        stroke="none"
      />
    </template>
  </svg>
</template>
