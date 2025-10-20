<template>
  <transition name="slide">
    <div
      v-if="isVisible"
      class="fixed top-0 left-0 h-full w-100 bg-gray-800 shadow-lg border-l border-gray-700 flex flex-col z-[9999]"
    >
      <div class="flex items-center justify-between p-4 border-b border-gray-700">
        <h2 class="text-lg font-semibold">{{ label }} {{ languages.COM_HISTORY }}</h2>
        <!--todo: close button clicks getting captured by header drag region-->
        <button @click="$emit('close')" class="svg-icon i-close w-6 h-6" />
      </div>
      <div class="flex-1 p-4">
        <HistoryNewChat v-show="props.mode == 'chat'" />
        <HistoryNewImageGen v-show="props.mode == 'imageGen'" />
        <HistoryNewImageEdit v-show="props.mode == 'imageEdit'" />
        <HistoryNewVideo v-show="props.mode == 'video'" />
      </div>
    </div>
  </transition>
</template>
<script setup lang="ts">

import HistoryNewChat from "@/components/HistoryNewChat.vue";
import HistoryNewImageEdit from "@/components/HistoryNewImageEdit.vue";
import HistoryNewVideo from "@/components/HistoryNewVideo.vue";
import HistoryNewImageGen from "@/components/HistoryNewImageGen.vue";

const props = defineProps<{
  mode: string
  label: string
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
