<template>
  <SideModalBase
    :is-visible="isVisible"
    :title="`${mapModeToLabel(mode)} ${languages.COM_HISTORY}`"
    side="left"
    @close="$emit('close')"
  >
    <template #header-buttons>
      <button
        v-show="mode === 'chat'"
        @click="selectNewConversation"
        class="svg-icon i-add w-7 h-7"
      />
    </template>

    <HistoryChat
      v-show="props.mode == 'chat'"
      @conversation-selected="emit('conversationSelected')"
    />
    <HistoryWorkflow v-show="props.mode === 'imageGen'" mode="imageGen" />
    <HistoryWorkflow v-show="props.mode === 'imageEdit'" mode="imageEdit" />
    <HistoryWorkflow v-show="props.mode === 'video'" mode="video" />
  </SideModalBase>
</template>

<script setup lang="ts">
import HistoryChat from '@/components/HistoryChat.vue'
import HistoryWorkflow from '@/components/HistoryWorkflow.vue'
import { useConversations } from '@/assets/js/store/conversations.ts'
import { mapModeToLabel } from '@/lib/utils.ts'
import SideModalBase from '@/components/SideModalBase.vue'

const conversations = useConversations()
const props = defineProps<{
  mode: ModeType
  isVisible: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'conversationSelected'): void
}>()

function selectNewConversation() {
  conversations.activeKey = Object.keys(conversations).pop() ?? ''
  emit('close')
}
</script>
