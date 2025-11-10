<script setup lang="ts">
import type { HoverCardRootProps, HoverCardRootEmits } from 'reka-ui'
import { provide, computed } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { useForwardPropsEmits } from 'reka-ui'
import { HoverCard } from '../hover-card'

export interface ContextProps extends HoverCardRootProps {
  usedTokens: number
  maxTokens: number
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

// Provide context data to child components
provide('contextData', {
  usedTokens: computed(() => props.usedTokens),
  maxTokens: computed(() => props.maxTokens),
  usage: computed(() => props.usage),
  modelId: computed(() => props.modelId),
})

// Only pass HoverCard props to HoverCard, not our custom props
const hoverCardProps = reactiveOmit(props, 'usedTokens', 'maxTokens', 'usage', 'modelId')
const forwarded = useForwardPropsEmits(hoverCardProps, emits)
</script>

<template>
  <HoverCard v-bind="forwarded">
    <slot />
  </HoverCard>
</template>

