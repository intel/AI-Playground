<script setup lang="ts">
import type { HoverCardRootProps, HoverCardRootEmits } from 'reka-ui'
import { computed } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { useForwardPropsEmits } from 'reka-ui'
import { InformationCircleIcon } from '@heroicons/vue/24/outline'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '../hover-card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip'
import { Button, type ButtonVariants } from '../button'

export interface ContextProps extends HoverCardRootProps {
  usedTokens: number
  maxTokens: number
  maxContextSize?: number
  dynamicContext?: boolean
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
  }
  modelId?: string
  triggerSize?: ButtonVariants['size']
}

const props = withDefaults(defineProps<ContextProps>(), {
  closeDelay: 0,
  openDelay: 0,
  triggerSize: 'default',
})

const emits = defineEmits<HoverCardRootEmits>()

// Only pass HoverCard props to HoverCard, not our custom props
const hoverCardProps = reactiveOmit(
  props,
  'usedTokens',
  'maxTokens',
  'maxContextSize',
  'dynamicContext',
  'usage',
  'modelId',
  'triggerSize',
)
const forwarded = useForwardPropsEmits(hoverCardProps, emits)

// Computed values for display
const usedPercent = computed(() => {
  if (props.maxTokens === 0) return 0
  return props.usedTokens / props.maxTokens
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
      <Button
        type="button"
        variant="ghost"
        :size="triggerSize"
        class="px-0"
        :aria-label="`Context usage: ${usedTokensFormatted ?? 0} of ${maxTokensFormatted ?? 0} tokens`"
      >
        <div class="relative h-4 w-16 overflow-hidden rounded-sm bg-muted">
          <div
            class="absolute inset-y-0 left-0 bg-[#00c4fa]/40 transition-all"
            :style="{ width: `${Math.min(100, Math.max(0, usedPercent * 100))}%` }"
          ></div>
          <span
            class="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] font-medium tabular-nums text-foreground"
          >
            {{ maxTokens > 0 ? `${usedTokensFormatted ?? 0}/${maxTokensFormatted}` : '—' }}
          </span>
        </div>
      </Button>
    </HoverCardTrigger>
    <HoverCardContent
      side="top"
      class="min-w-60 divide-y overflow-hidden p-0 bg-card border-border text-foreground"
    >
      <div class="w-full p-3 space-y-2 text-xs">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">Context Usage</h2>
          <h2 class="text-sm font-medium">Tokens</h2>
        </div>
        <div v-if="maxContextSizeFormatted" class="flex items-center justify-between">
          <span class="text-muted-foreground">Max Context for Model</span>
          <span>{{ maxContextSizeFormatted }}</span>
        </div>
        <div v-if="dynamicContext" class="flex items-center justify-between">
          <span class="text-muted-foreground">Configured Context Size</span>
          <TooltipProvider :delay-duration="0">
            <Tooltip>
              <TooltipTrigger as-child>
                <span
                  class="inline-flex items-center gap-1 cursor-help underline decoration-dotted"
                >
                  Dynamic
                  <InformationCircleIcon class="size-3.5 text-muted-foreground" />
                </span>
              </TooltipTrigger>
              <TooltipContent class="max-w-56 text-center">
                The context size is determined automatically at runtime based on the available VRAM.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div v-else-if="maxTokensFormatted" class="flex items-center justify-between">
          <span class="text-muted-foreground">Configured Context Size</span>
          <span>{{ maxTokensFormatted }}</span>
        </div>
        <div v-if="usedTokensFormatted" class="flex items-center justify-between">
          <span class="text-muted-foreground">Used Context</span>
          <span>{{ usedTokensFormatted }}</span>
        </div>
        <div v-if="inputTokensFormatted" class="flex items-center justify-between">
          <span class="text-muted-foreground">Input</span>
          <span>{{ inputTokensFormatted }}</span>
        </div>
        <div v-if="outputTokensFormatted" class="flex items-center justify-between">
          <span class="text-muted-foreground">Output</span>
          <span>{{ outputTokensFormatted }}</span>
        </div>
      </div>
    </HoverCardContent>
  </HoverCard>
</template>
