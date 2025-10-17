<template>
  <transition name="slide">
    <div
      v-if="isVisible"
      class="fixed top-0 right-0 h-full w-130 bg-gray-800 shadow-lg border-l border-gray-700 flex flex-col"
    >
      <div class="flex items-center justify-between p-4 border-b border-gray-700">
        <h2 class="text-lg font-semibold">{{ label }} Settings</h2>
        <button @click="$emit('close')" class="svg-icon i-close w-6 h-6"/>
      </div>
      <div class="flex-1 p-4">
        <SettingsNewChat v-show="props.mode == 'chat'"/>
        <SettingsNewImageGen v-show="props.mode == 'imageGen'"/>
        <SettingsNewImageEdit v-show="props.mode == 'imageEdit'"/>
        <SettingsNewVideo v-show="props.mode == 'video'"/>
      </div>
    </div>
  </transition>
</template>
<script setup lang="ts">

import SettingsNewChat from "@/components/SettingsNewChat.vue";
import SettingsNewImageGen from "@/components/SettingsNewImageGen.vue";
import SettingsNewImageEdit from "@/components/SettingsNewImageEdit.vue";
import SettingsNewVideo from "@/components/SettingsNewVideo.vue";

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
  transform: translateX(100%);
}
</style>
