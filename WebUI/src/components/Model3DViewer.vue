<template>
  <model-viewer
    :src="src"
    skybox-image="/src/assets/image/qwantani_moonrise_puresky_8k.jpg"
    camera-controls
    auto-rotate
    class="w-full h-full"
    style="background-color: transparent;"
    :style="{ width: '100%', height: '100%' }"
  />
</template>

<script setup lang="ts">
import '@google/model-viewer'

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

