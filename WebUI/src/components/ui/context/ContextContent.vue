<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { HoverCardContent } from '../hover-card'
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <HoverCardContent :class="cn('min-w-60 divide-y overflow-hidden p-0', props.class)">
    <slot />
  </HoverCardContent>
</template>
