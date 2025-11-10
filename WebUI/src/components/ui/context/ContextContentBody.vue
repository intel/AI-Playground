<script setup lang="ts">
import { inject, computed } from 'vue'
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

type ContextData = {
  usage?: { value?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number } }
}

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

const contextData = inject<ContextData>('contextData')

if (!contextData) {
  throw new Error('ContextContentBody must be used within Context')
}

const inputTokens = computed(() => contextData.usage?.value?.inputTokens ?? 0)
const outputTokens = computed(() => contextData.usage?.value?.outputTokens ?? 0)
const cachedInputTokens = computed(() => contextData.usage?.value?.cachedInputTokens ?? 0)
const reasoningTokens = computed(() => contextData.usage?.value?.reasoningTokens ?? 0)

const formatTokens = (tokens: number) => {
  if (tokens === 0) return null
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
  }).format(tokens)
}

const formattedInputTokens = computed(() => formatTokens(inputTokens.value))
const formattedOutputTokens = computed(() => formatTokens(outputTokens.value))
const formattedCachedTokens = computed(() => formatTokens(cachedInputTokens.value))
const formattedReasoningTokens = computed(() => formatTokens(reasoningTokens.value))
</script>

<template>
  <div :class="cn('w-full p-3', props.class)">
    <slot>
      <div class="space-y-2 text-xs">
        <div
          v-if="formattedInputTokens"
          class="flex items-center justify-between"
        >
          <span class="text-muted-foreground">Input</span>
          <span>{{ formattedInputTokens }}</span>
        </div>
        <div
          v-if="formattedOutputTokens"
          class="flex items-center justify-between"
        >
          <span class="text-muted-foreground">Output</span>
          <span>{{ formattedOutputTokens }}</span>
        </div>
        <div
          v-if="formattedReasoningTokens"
          class="flex items-center justify-between"
        >
          <span class="text-muted-foreground">Reasoning</span>
          <span>{{ formattedReasoningTokens }}</span>
        </div>
        <div
          v-if="formattedCachedTokens"
          class="flex items-center justify-between"
        >
          <span class="text-muted-foreground">Cache</span>
          <span>{{ formattedCachedTokens }}</span>
        </div>
      </div>
    </slot>
  </div>
</template>

