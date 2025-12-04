<template>
  <model-viewer
    :src="src"
    :skybox-image="skyboxImage"
    camera-controls
    auto-rotate
    class="w-full h-full"
    style="background-color: transparent"
    :style="{ width: '100%', height: '100%', zIndex: 5 }"
  />
</template>

<script setup lang="ts">
import '@google/model-viewer'
import skyboxImage from '@/assets/image/qwantani_moonrise_puresky_8k.jpg'

defineProps<{
  src: string
}>()
</script>

<style scoped>
model-viewer {
  width: 100%;
  height: 100%;
  background-color: transparent;
}
</style>
