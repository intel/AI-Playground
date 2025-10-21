<template>
  <transition name="slide">
    <div
      v-show="isVisible"
      class="fixed top-0 left-0 h-full w-130 bg-gray-800 shadow-lg border-l border-gray-700 flex flex-col z-[9999]"
    >
      <div class="flex items-center justify-between p-4 border-b border-gray-700">
        <h2 class="text-lg font-semibold">App Settings</h2>
        <button @click="$emit('close')" class="svg-icon i-close w-6 h-6" />
      </div>
      <div class="flex-1 p-4">
        App Settings Here
      </div>
    </div>
  </transition>
</template>
<script setup lang="ts">


defineProps<{
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()

</script>

<style scoped>
.slide-enter-active, .slide-leave-active {
  transition: transform 0.3s ease;
}

.slide-enter-from, .slide-leave-to {
  transform: translateX(-100%);
}
</style>
