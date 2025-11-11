<template>
  <div class="flex gap-2 items-center overflow-hidden text-ellipsis">
    <span
      class="rounded-full w-2 h-2 shrink-0"
      :class="{ 'bg-primary': model.downloaded, 'bg-muted-foreground': !model.downloaded }"
    ></span>
    <span class="h-7 overflow-hidden">{{ toDisplayName(model.name) }}</span>
  </div>
</template>
<script setup lang="ts">
import { type LlmModel } from '@/assets/js/store/textInference'

// only shows the filename for .gguf models
function toDisplayName(name: string) {
  return name.includes('.gguf') ? name.split('/').pop() : name
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const props = withDefaults(
  defineProps<{
    model?: LlmModel
  }>(),
  {
    model: () => ({
      name: 'model not found',
      type: 'ipexLLM',
      downloaded: false,
      default: false,
      active: false,
    }),
  },
)
</script>
