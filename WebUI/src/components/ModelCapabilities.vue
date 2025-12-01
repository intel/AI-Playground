<script setup lang="ts">
import { computed } from 'vue'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip'
import { InformationCircleIcon } from '@heroicons/vue/24/outline'

interface ModelCapabilities {
  supportsToolCalling?: boolean
  supportsVision?: boolean
  maxContextSize?: number
  name?: string
  npuSupport?: boolean
}

const props = withDefaults(
  defineProps<{
    model: ModelCapabilities
    iconSize?: string
    delayDuration?: number
  }>(),
  {
    iconSize: 'size-4',
    delayDuration: 100,
  },
)

const formatCapabilities = () => {
  const caps: string[] = []
  if (props.model.supportsVision) caps.push('Vision')
  if (props.model.supportsToolCalling) caps.push('Tool Calling')
  if (props.model.npuSupport) caps.push('NPU Support')
  return caps
}

const formatMaxContextSize = (size?: number) => {
  if (!size) return null
  return new Intl.NumberFormat('en-US').format(size)
}

const capabilities = computed(() => formatCapabilities())
const maxContextSizeFormatted = computed(() => formatMaxContextSize(props.model.maxContextSize))
</script>

<template>
  <TooltipProvider>
  <Tooltip :delay-duration="delayDuration">
    <TooltipTrigger as-child>
      <button type="button" class="p-0.5">
        <InformationCircleIcon :class="[iconSize, 'text-muted-foreground']" />
      </button>
    </TooltipTrigger>
    <TooltipContent class="w-64 bg-card border border-border text-foreground p-3 z-[200]">
      <div class="space-y-2">
        <div class="space-y-1">
          <h3 class="text-sm font-semibold">Model Info</h3>
        <div v-if="model.maxContextSize" class="space-y-1">
          <p class="text-xs text-muted-foreground">
            Max Context Size: {{ maxContextSizeFormatted }} tokens
          </p>
        </div>
          <h4 class="text-xs">Capabilities</h4>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="cap in capabilities"
              :key="cap"
              class="px-2 py-1 text-xs bg-primary/10 text-primary rounded-md"
            >
              {{ cap }}
            </span>
            <span
              v-if="capabilities.length === 0"
              class="px-2 py-1 text-xs bg-muted text-muted-foreground rounded-md"
            >
              Standard
            </span>
          </div>
        </div>
      </div>
    </TooltipContent>
  </Tooltip>
  </TooltipProvider>
</template>

