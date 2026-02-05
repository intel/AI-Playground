<template>
  <transition :name="slideTransition">
    <div
      v-if="isVisible"
      :class="[
        'bg-card shadow-lg flex flex-col z-9 border-border h-full',
        'absolute 2xl:relative top-0',
        side === 'left' ? 'left-0 border-r w-100' : 'right-0 border-l w-130',
      ]"
    >
      <div class="flex items-center justify-between p-4 border-b border-border">
        <h2 class="text-lg font-semibold">{{ title }}</h2>
        <div class="flex gap-3 items-center">
          <slot name="header-buttons" />
          <button
            @click="$emit('close')"
            :class="[
              'svg-icon w-6 h-6',
              '!hidden 2xl:!inline-block',
              side === 'left' ? 'i-arrow-left' : 'i-arrow-right',
            ]"
            :title="languages.COM_CLOSE"
          />
          <button
            @click="$emit('close')"
            :class="['svg-icon i-close w-6 h-6', '!inline-block 2xl:!hidden']"
            :title="languages.COM_CLOSE"
          />
        </div>
      </div>
      <div class="flex-1 p-4 overflow-y-auto">
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

const slideTransition = computed(() => (props.side === 'left' ? 'slide-left' : 'slide-right'))
</script>

<style scoped>
@media (max-width: 1535px) {
  .slide-right-enter-active,
  .slide-right-leave-active,
  .slide-left-enter-active,
  .slide-left-leave-active {
    transition: opacity 0.2s ease;
  }

  .slide-right-enter-from,
  .slide-right-leave-to,
  .slide-left-enter-from,
  .slide-left-leave-to {
    opacity: 0;
  }
}

@media (min-width: 1536px) {
  .slide-right-enter-active,
  .slide-right-leave-active,
  .slide-left-enter-active,
  .slide-left-leave-active {
    transition: transform 0.3s ease;
  }

  .slide-right-enter-from,
  .slide-right-leave-to {
    transform: translateX(100%);
  }

  .slide-left-enter-from,
  .slide-left-leave-to {
    transform: translateX(-100%);
  }
}
</style>
