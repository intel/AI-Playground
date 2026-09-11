<script setup lang="ts">
import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'vue'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <div class="relative w-full overflow-auto">
    <table :class="cn('w-full caption-bottom text-sm text-foreground', props.class)">
      <slot />
    </table>
  </div>
</template>
