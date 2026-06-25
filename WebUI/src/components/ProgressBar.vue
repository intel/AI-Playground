<template>
  <div class="v-progress-bar">
    <div v-if="props.text" class="text-foreground text-center whitespace-pre-line">
      {{ props.text }}
    </div>
    <div class="v-progress-bar-percent-bg">
      <div class="v-progress-bar-percent" :style="{ width: `${props.percent}%` }"></div>
    </div>
  </div>
</template>
<script setup lang="ts">
const props = defineProps<{
  percent: number
  text?: string
}>()
</script>
