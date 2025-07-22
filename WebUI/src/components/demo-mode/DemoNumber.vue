<template>
  <transition name="fade">
    <div v-if="props.show" class="demo-step-number" :class="props.extraClass">
      {{ props.number }}
    </div>
  </transition>
</template>

<script setup lang="ts">
const props = defineProps<{
  show: boolean
  number: number
  extraClass?: string
}>()
</script>
