<script setup lang="ts">
import { inject, computed } from 'vue'
import type { HTMLAttributes } from 'vue'
import { Progress } from '../progress'
import { cn } from '@/lib/utils'

const PERCENT_MAX = 100

type ContextData = {
  usedTokens: { value: number }
  maxTokens: { value: number }
  maxContextSize?: { value?: number }
}

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

const contextData = inject<ContextData>('contextData')

if (!contextData) {
  throw new Error('ContextContentHeader must be used within Context')
}

const usedPercent = computed(() => {
  if (contextData.maxTokens.value === 0) return 0
  return contextData.usedTokens.value / contextData.maxTokens.value
})

const displayPct = computed(() => {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(usedPercent.value)
})

const used = computed(() => {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
  }).format(contextData.usedTokens.value)
})

const total = computed(() => {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
  }).format(contextData.maxTokens.value)
})

const maxContextSize = computed(() => {
  return contextData.maxContextSize?.value
})

const maxContextSizeFormatted = computed(() => {
  if (!maxContextSize.value) return null
  return new Intl.NumberFormat('en-US').format(maxContextSize.value)
})
</script>

<template>
  <div :class="cn('w-full space-y-2 p-3', props.class)">
    <slot>
      <div class="flex items-center justify-between gap-3 text-xs">
        <p>{{ displayPct }}</p>
        <div class="flex items-center gap-2">
          <p class="font-mono text-muted-foreground">{{ used }} / {{ total }}</p>
          <p v-if="maxContextSizeFormatted" class="text-muted-foreground/70">
            (max: {{ maxContextSizeFormatted }})
          </p>
        </div>
      </div>
      <div class="space-y-2">
        <Progress class="bg-muted" :model-value="usedPercent * PERCENT_MAX" />
      </div>
    </slot>
  </div>
</template>
