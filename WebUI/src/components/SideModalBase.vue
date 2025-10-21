<template>
  <transition name="fade">
    <div
      v-show="isVisible"
      class="fixed inset-0 z-[9998]"
      @click="$emit('close')"
    />
  </transition>
  <transition :name="slideTransition">
    <div
      v-if="isVisible"
      :class="[
        'fixed top-0 h-full w-130 bg-gray-800 shadow-lg flex flex-col z-[9999]',
        side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
        'border-gray-700'
      ]"
    >
      <div class="flex items-center justify-between p-4 border-b border-gray-700">
        <h2 class="text-lg font-semibold">{{ title }}</h2>
        <div class="flex gap-3 items-center">
          <slot name="header-buttons" />
          <button @click="$emit('close')" class="svg-icon i-close w-6 h-6"/>
        </div>
      </div>
      <div class="flex-1 p-4">
        <slot />
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  isVisible: boolean
  title: string
  side: 'left' | 'right'
}>()

defineEmits<{
  close: []
}>()

const slideTransition = computed(() =>
  props.side === 'left' ? 'slide-left' : 'slide-right'
)
</script>

<style scoped>
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}

.slide-right-enter-active, .slide-right-leave-active {
  transition: transform 0.3s ease;
}
.slide-right-enter-from, .slide-right-leave-to {
  transform: translateX(100%);
}

.slide-left-enter-active, .slide-left-leave-active {
  transition: transform 0.3s ease;
}
.slide-left-enter-from, .slide-left-leave-to {
  transform: translateX(-100%);
}
div, button {
  -webkit-app-region: none;
}
</style>
