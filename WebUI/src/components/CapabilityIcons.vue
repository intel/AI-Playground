<script setup lang="ts">
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import {
  CAPABILITIES,
  type CapabilityDescriptor,
  type CapabilityFlags,
  type CapabilityKey,
} from '@/assets/js/capabilities'

const props = withDefaults(
  defineProps<{
    /** Model whose capabilities are shown (display mode). Ignored in filter mode. */
    model?: CapabilityFlags | null
    /**
     * 'display' greys out capabilities the model lacks.
     * 'filter' renders toggle buttons; selected keys highlight and emit `toggle`.
     */
    mode?: 'display' | 'filter'
    /** Currently-active filter keys (filter mode only). */
    activeKeys?: Set<CapabilityKey>
    iconSize?: string
    delayDuration?: number
  }>(),
  {
    model: null,
    mode: 'display',
    iconSize: 'size-4',
    delayDuration: 100,
  },
)

const emit = defineEmits<{ (e: 'toggle', key: CapabilityKey): void }>()

function has(cap: CapabilityDescriptor): boolean {
  return props.model?.[cap.flag] === true
}

function isActive(key: CapabilityKey): boolean {
  return props.activeKeys?.has(key) === true
}
</script>

<template>
  <TooltipProvider>
    <div class="flex items-center gap-0.5">
      <Tooltip v-for="cap in CAPABILITIES" :key="cap.key" :delay-duration="delayDuration">
        <TooltipTrigger as-child>
          <component
            :is="mode === 'filter' ? 'button' : 'span'"
            :type="mode === 'filter' ? 'button' : undefined"
            :aria-pressed="mode === 'filter' ? isActive(cap.key) : undefined"
            :aria-label="cap.label"
            class="flex items-center justify-center rounded p-0.5 transition-opacity"
            :class="[
              mode === 'filter'
                ? isActive(cap.key)
                  ? 'text-primary opacity-100'
                  : 'text-muted-foreground opacity-40 hover:opacity-100 cursor-pointer'
                : has(cap)
                  ? 'text-foreground opacity-100'
                  : 'text-muted-foreground opacity-30',
            ]"
            @click="mode === 'filter' ? emit('toggle', cap.key) : undefined"
          >
            <component :is="cap.icon" :class="iconSize" />
          </component>
        </TooltipTrigger>
        <TooltipContent class="w-56 bg-card border border-border text-foreground p-2 z-[200]">
          <p class="text-xs font-semibold">{{ cap.label }}</p>
          <p class="text-xs text-muted-foreground">
            <template v-if="mode === 'filter'">
              {{
                isActive(cap.key)
                  ? 'Filtering to models with this capability'
                  : 'Show only models with this capability'
              }}
            </template>
            <template v-else>
              {{
                has(cap) ? cap.tooltip : `This model does not support ${cap.label.toLowerCase()}.`
              }}
            </template>
          </p>
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
</template>
