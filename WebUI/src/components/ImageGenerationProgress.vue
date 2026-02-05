<template>
  <div class="absolute inset-0 flex items-center justify-center image-generation-progress">
    <div
      class="flex flex-col items-center justify-center gap-4 bg-background/40 backdrop-blur-sm rounded-2xl px-12 py-8 border border-border/50 shadow-lg progress-content"
    >
      <div class="flex items-center justify-center spinner-container">
        <Spinner class="w-12 h-12 text-primary" />
      </div>
      <div class="text-foreground font-semibold text-center progress-text">
        <span class="text-2xl tabular-nums font-semibold">{{ stepText || 'Generating...' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Spinner } from '@/components/ui/spinner'

defineProps<{
  stepText?: string
}>()
</script>

<style scoped>
.image-generation-progress {
  animation: fadeIn 0.3s ease-out;
}

.progress-content {
  animation: fadeInScale 0.4s ease-out;
}

.progress-text {
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes fadeInScale {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
