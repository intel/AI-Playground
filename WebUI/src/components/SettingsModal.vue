<template>
  <transition name="slide">
    <div
      v-show="isVisible"
      class="fixed top-0 right-0 h-full w-130 bg-gray-800 shadow-lg border-l border-gray-700 flex flex-col"
    >
      <div class="flex items-center justify-between p-4 border-b border-gray-700">
        <h2 class="text-lg font-semibold">{{ mapModeToLabel(mode)  }} Settings</h2>
        <button @click="$emit('close')" class="svg-icon i-close w-6 h-6"/>
      </div>
      <div class="flex-1 p-4">
        <SettingsChat v-show="props.mode == 'chat'"/>
        <SettingsImageGen v-show="props.mode == 'imageGen'"/>
        <SettingsImageEdit v-show="props.mode == 'imageEdit'"/>
        <SettingsVideo v-show="props.mode == 'video'"/>
      </div>
    </div>
  </transition>
</template>
<script setup lang="ts">

import SettingsChat from "@/components/SettingsChat.vue";
import SettingsImageGen from "@/components/SettingsImageGen.vue";
import SettingsImageEdit from "@/components/SettingsImageEdit.vue";
import SettingsVideo from "@/components/SettingsVideo.vue";
import { mapModeToLabel } from "@/lib/utils.ts";

const props = defineProps<{
  mode: ModeType
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
