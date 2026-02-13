<script setup lang="ts">
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

defineProps<{
  icon: string
  tooltip: string
}>()

defineEmits<{
  click: []
}>()
</script>

<template>
  <TooltipProvider :delay-duration="200">
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          class="bg-muted rounded-xs w-6 h-6 flex items-center justify-center"
          @click="$emit('click')"
        >
          <span class="svg-icon text-foreground w-4 h-4" :class="icon"></span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {{ tooltip }}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
