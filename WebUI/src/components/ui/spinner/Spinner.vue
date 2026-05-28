<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Loader2Icon } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { useI18N } from '@/assets/js/store/i18n'

const i18nState = useI18N().state

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <Loader2Icon
    role="status"
    :aria-label="i18nState.COM_LOADING"
    :class="cn('size-4 animate-spin', props.class)"
  />
</template>
