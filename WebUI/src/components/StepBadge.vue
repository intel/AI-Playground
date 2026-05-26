<template>
  <div
    class="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold"
    :class="done ? 'bg-green-500/20 text-green-500' : 'bg-primary/20 text-primary'"
  >
    {{ step }}
  </div>
</template>

<script setup lang="ts">
defineProps<{
  step: number
  done?: boolean
}>()
</script>
