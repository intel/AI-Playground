<script setup lang="ts">
import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'vue'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <thead :class="cn('[&_tr]:border-b [&_tr]:border-border', props.class)">
    <slot />
  </thead>
</template>
