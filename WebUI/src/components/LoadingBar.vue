<template>
  <div class="v-loading">
    <p class="v-loading-text whitespace-pre-line">{{ props.text }}</p>
    <div class="v-loading-bar">
      <div class="v-loading-bar-thumb"></div>
    </div>
  </div>
</template>
<script lang="ts" setup>
const props = defineProps<{
  text: string
}>()
</script>
