<script setup lang="ts">
import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'vue'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <th
    scope="col"
    :class="
      cn(
        'h-9 px-3 text-left align-middle text-xs font-medium text-muted-foreground whitespace-nowrap',
        props.class,
      )
    "
  >
    <slot />
  </th>
</template>
