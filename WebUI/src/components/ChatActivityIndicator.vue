<template>
  <div v-if="activity" class="flex items-start gap-3" role="status" aria-live="polite">
    <img v-if="withAvatar" class="size-6 shrink-0" src="../assets/svg/ai-icon.svg" />
    <div class="flex min-w-0 flex-col gap-1.5" :class="withAvatar ? 'pt-0.5' : ''">
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <span class="activity-dots" aria-hidden="true">
          <span></span><span></span><span></span>
        </span>
        <span class="activity-label truncate">{{ activity.label }}</span>
        <span
          v-if="activity.progress !== undefined"
          class="shrink-0 tabular-nums text-xs text-muted-foreground/70"
        >
          {{ Math.round((activity.progress ?? 0) * 100) }}%
        </span>
      </div>
      <div
        v-if="activity.progress !== undefined"
        class="h-1 w-48 max-w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          class="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          :style="{ width: `${Math.round((activity.progress ?? 0) * 100)}%` }"
        ></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useActivities } from '@/assets/js/store/activities'

const props = withDefaults(
  defineProps<{
    conversationKey: string
    // Render a leading AI avatar (used when shown as a standalone turn, e.g. during
    // backend prep before the assistant message bubble exists).
    withAvatar?: boolean
  }>(),
  { withAvatar: false },
)

const activities = useActivities()

// The single most-specific active activity for this conversation (innermost child
// when tools are nested). Reactive via the store's `items` ref. 'generation' is
// excluded because the inline ChatWorkflowResult already visualizes image-gen
// progress (thumbnails + steps); here we keep the parent "Generating image…".
const activity = computed(() => activities.chatActivity(props.conversationKey, ['generation']))
</script>

<style scoped>
.activity-dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.activity-dots span {
  width: 5px;
  height: 5px;
  border-radius: 9999px;
  background-color: currentColor;
  opacity: 0.4;
  animation: activity-dot 1.2s infinite ease-in-out both;
}

.activity-dots span:nth-child(1) {
  animation-delay: -0.24s;
}

.activity-dots span:nth-child(2) {
  animation-delay: -0.12s;
}

.activity-label {
  background: linear-gradient(
    90deg,
    hsl(var(--muted-foreground)) 25%,
    hsl(var(--foreground)) 50%,
    hsl(var(--muted-foreground)) 75%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: activity-shimmer 2.4s linear infinite;
}

@keyframes activity-dot {
  0%,
  80%,
  100% {
    transform: scale(0.7);
    opacity: 0.3;
  }
  40% {
    transform: scale(1);
    opacity: 0.9;
  }
}

@keyframes activity-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .activity-dots span,
  .activity-label {
    animation: none;
  }
  .activity-label {
    -webkit-text-fill-color: hsl(var(--muted-foreground));
  }
}
</style>
