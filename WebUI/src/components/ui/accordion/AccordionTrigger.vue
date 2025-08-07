<script setup lang="ts">
import type { AccordionTriggerProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { ChevronDownIcon } from '@radix-icons/vue'
import { AccordionHeader, AccordionTrigger } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<AccordionTriggerProps & { class?: HTMLAttributes['class'] }>()

const delegatedProps = reactiveOmit(props, 'class')
</script>

<template>
  <AccordionHeader class="flex">
    <AccordionTrigger
      data-slot="accordion-trigger"
      v-bind="delegatedProps"
      :class="
        cn(
          'focus-visible:border-slate-950 focus-visible:ring-slate-950/50 flex flex-1 items-start justify-between gap-4 rounded-md py-1 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180 dark:focus-visible:border-slate-300 dark:focus-visible:ring-slate-300/50',
          props.class,
        )
      "
    >
      <slot />
      <slot name="icon">
        <ChevronDownIcon
          class="text-slate-500 pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-200 dark:text-slate-400"
        />
      </slot>
    </AccordionTrigger>
  </AccordionHeader>
</template>
