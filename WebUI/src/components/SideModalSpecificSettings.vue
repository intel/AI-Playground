<template>
  <SideModalBase
    :is-visible="isVisible"
    :title="`${mapModeToLabel(mode)} Settings`"
    side="right"
    @close="$emit('close')"
  >
    <SettingsChat v-show="props.mode == 'chat'" />
    <SettingsImageGen v-show="props.mode == 'imageGen'" />
    <SettingsImageEdit v-show="props.mode == 'imageEdit'" />
    <SettingsVideo v-show="props.mode == 'video'" />
  </SideModalBase>
</template>

<script setup lang="ts">
import SideModalBase from '@/components/SideModalBase.vue'
import SettingsChat from '@/components/SettingsChat.vue'
import SettingsImageGen from '@/components/SettingsImageGen.vue'
import SettingsImageEdit from '@/components/SettingsImageEdit.vue'
import SettingsVideo from '@/components/SettingsVideo.vue'
import { mapModeToLabel } from '@/lib/utils.ts'

const props = defineProps<{
  mode: ModeType
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()
</script>
