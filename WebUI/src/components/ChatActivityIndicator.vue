<template>
  <div v-if="activity" class="flex items-start gap-3" role="status" aria-live="polite">
    <img class="size-6" src="../assets/svg/ai-icon.svg" />
    <div class="flex flex-col gap-2 w-full max-w-md">
      <!-- Determinate progress (e.g. image generation steps) -->
      <div v-if="activity.progress !== undefined" class="flex flex-col gap-1">
        <span class="text-sm text-muted-foreground">{{ activity.label }}</span>
        <div class="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            class="h-full bg-primary transition-[width] duration-200 ease-out"
            :style="{ width: `${Math.round((activity.progress ?? 0) * 100)}%` }"
          ></div>
        </div>
      </div>
      <!-- Indeterminate (thinking, backend prep, tool resolution, …) -->
      <loading-bar v-else :text="activity.label" class="w-full" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import LoadingBar from '@/components/LoadingBar.vue'
import { useActivities } from '@/assets/js/store/activities'

const props = defineProps<{
  conversationKey: string
}>()

const activities = useActivities()

// The single most-specific active activity for this conversation (innermost child
// when tools are nested). Reactive via the store's `items` ref. 'generation' is
// excluded because the inline ChatWorkflowResult already visualizes image-gen
// progress (thumbnails + steps); here we keep the parent "Generating image…".
const activity = computed(() => activities.chatActivity(props.conversationKey, ['generation']))
</script>
