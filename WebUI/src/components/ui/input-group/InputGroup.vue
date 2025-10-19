<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="input-group"
    role="group"
    :class="cn(
      'group/input-group border-slate-200 dark:bg-slate-200/30 relative flex w-full items-center rounded-md border shadow-xs transition-[color,box-shadow] outline-none dark:border-slate-800 dark:dark:bg-slate-800/30',
      'h-9 min-w-0 has-[>textarea]:h-auto',

      // Variants based on alignment.
      'has-[>[data-align=inline-start]]:[&>input]:pl-2',
      'has-[>[data-align=inline-end]]:[&>input]:pr-2',
      'has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:[&>input]:pb-3',
      'has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-3',

      // Focus state.
      'has-[[data-slot=input-group-control]:focus-visible]:ring-slate-950 has-[[data-slot=input-group-control]:focus-visible]:ring-1 dark:has-[[data-slot=input-group-control]:focus-visible]:ring-slate-300',

      props.class,
    )"
  >
    <slot />
  </div>
</template>
