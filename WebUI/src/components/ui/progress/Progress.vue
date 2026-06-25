<script setup lang="ts">
import type { ProgressRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { ProgressIndicator, ProgressRoot } from 'reka-ui'
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<ProgressRootProps & { class?: HTMLAttributes['class'] }>(), {
  modelValue: 0,
})

const delegatedProps = reactiveOmit(props, 'class', 'modelValue')

const progressValue = computed(() => Math.min(100, Math.max(0, props.modelValue ?? 0)))
</script>

<template>
  <ProgressRoot
    v-bind="delegatedProps"
    :model-value="progressValue"
    :class="
      cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-slate-900/20 dark:bg-slate-50/20',
        props.class,
      )
    "
  >
    <ProgressIndicator
      class="h-full w-full flex-1 bg-slate-900 transition-all dark:bg-slate-50"
      :style="`transform: translateX(-${100 - progressValue}%);`"
    />
  </ProgressRoot>
</template>
