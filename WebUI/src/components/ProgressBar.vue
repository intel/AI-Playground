<template>
  <div class="v-progress-bar">
    <div v-if="props.text" class="text-white text-center" v-html="html"></div>
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

const html = computed(() => (props.text == null ? '' : props.text.replace('\r\n', '<br/>')))
</script>
