<script setup lang="ts">
import type { HoverCardRootProps, HoverCardRootEmits } from 'reka-ui'
import { computed } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { useForwardPropsEmits } from 'reka-ui'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '../hover-card'
import { Button } from '../button'
import ContextIcon from './ContextIcon.vue'

export interface ContextProps extends HoverCardRootProps {
  usedTokens: number
  maxTokens: number
  maxContextSize?: number
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
  }
  modelId?: string
}

const props = withDefaults(defineProps<ContextProps>(), {
  closeDelay: 0,
  openDelay: 0,
})

const emits = defineEmits<HoverCardRootEmits>()

// Only pass HoverCard props to HoverCard, not our custom props
const hoverCardProps = reactiveOmit(props, 'usedTokens', 'maxTokens', 'maxContextSize', 'usage', 'modelId')
const forwarded = useForwardPropsEmits(hoverCardProps, emits)

// Computed values for display
const usedPercent = computed(() => {
  if (props.maxTokens === 0) return 0
  return props.usedTokens / props.maxTokens
})

const renderedPercent = computed(() => {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(usedPercent.value)
})

const formatNumber = (value?: number) => {
  if (value === undefined || value === null) return null
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
  }).format(value)
}

const maxContextSizeFormatted = computed(() => formatNumber(props.maxContextSize))
const maxTokensFormatted = computed(() => formatNumber(props.maxTokens))
const usedTokensFormatted = computed(() => formatNumber(props.usedTokens))
const inputTokensFormatted = computed(() => formatNumber(props.usage?.inputTokens))
const outputTokensFormatted = computed(() => formatNumber(props.usage?.outputTokens))
</script>

<template>
  <HoverCard v-bind="forwarded">
    <HoverCardTrigger as-child>
      <Button type="button" variant="ghost">
        <span class="font-medium text-muted-foreground">
          {{ renderedPercent }}
        </span>
        <ContextIcon :used-tokens="usedTokens" :max-tokens="maxTokens" />
      </Button>
    </HoverCardTrigger>
    <HoverCardContent class="min-w-60 divide-y overflow-hidden p-0">
      <div class="w-full p-3 space-y-2 text-xs">
        <div
          class="flex items-center justify-between"
        >
          <h2 class="text-sm font-semibold">Context Usage</h2>
          <h2 class="text-sm font-medium">Tokens</h2>
        </div>
        <div
          v-if="maxContextSizeFormatted"
          class="flex items-center justify-between"
        >
          <span class="text-muted-foreground">Max Context for Model</span>
          <span>{{ maxContextSizeFormatted }}</span>
        </div>
        <div
          v-if="maxTokensFormatted"
          class="flex items-center justify-between"
        >
          <span class="text-muted-foreground">Configured Context Size</span>
          <span>{{ maxTokensFormatted }}</span>
        </div>
        <div
          v-if="usedTokensFormatted"
          class="flex items-center justify-between"
        >
          <span class="text-muted-foreground">Used Context</span>
          <span>{{ usedTokensFormatted }}</span>
        </div>
        <div
          v-if="inputTokensFormatted"
          class="flex items-center justify-between"
        >
          <span class="text-muted-foreground">Input</span>
          <span>{{ inputTokensFormatted }}</span>
        </div>
        <div
          v-if="outputTokensFormatted"
          class="flex items-center justify-between"
        >
          <span class="text-muted-foreground">Output</span>
          <span>{{ outputTokensFormatted }}</span>
        </div>
      </div>
    </HoverCardContent>
  </HoverCard>
</template>

