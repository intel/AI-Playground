<script setup lang="ts">
import { cn } from '@/lib/utils'
import { ChevronRightIcon } from '@radix-icons/vue'
import { DropdownMenuSubTrigger, type DropdownMenuSubTriggerProps, useForwardProps } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

const props = defineProps<DropdownMenuSubTriggerProps & { class?: HTMLAttributes['class'] }>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props

  return delegated
})

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <DropdownMenuSubTrigger
    v-bind="forwardedProps"
    :class="
      cn(
        'flex cursor-default select-none items-center rounded-xs px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
        props.class,
      )
    "
  >
    <slot />
    <ChevronRightIcon class="ml-auto h-4 w-4" />
  </DropdownMenuSubTrigger>
</template>
