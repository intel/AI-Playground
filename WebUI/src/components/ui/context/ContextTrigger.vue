<script setup lang="ts">
import { inject, computed } from 'vue'
import { Button } from '../button'
import { HoverCardTrigger } from '../hover-card'
import ContextIcon from './ContextIcon.vue'

type ContextData = {
  usedTokens: { value: number }
  maxTokens: { value: number }
}

const contextData = inject<ContextData>('contextData')

if (!contextData) {
  throw new Error('ContextTrigger must be used within Context')
}

const usedPercent = computed(() => {
  if (contextData.maxTokens.value === 0) return 0
  return contextData.usedTokens.value / contextData.maxTokens.value
})

const renderedPercent = computed(() => {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(usedPercent.value)
})
</script>

<template>
  <HoverCardTrigger as-child>
    <Button type="button" variant="ghost">
      <span class="font-medium text-muted-foreground">
        {{ renderedPercent }}
      </span>
      <ContextIcon />
    </Button>
  </HoverCardTrigger>
</template>

