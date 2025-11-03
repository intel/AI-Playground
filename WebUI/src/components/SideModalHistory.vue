<template>
  <SideModalBase
    :is-visible="isVisible"
    :title="`${mapModeToLabel(mode)} ${languages.COM_HISTORY}`"
    side="left"
    @close="$emit('close')"
  >
    <template #header-buttons>
      <AlertDialog v-if="mode !== 'chat'">
        <AlertDialogTrigger asChild>
          <button class="svg-icon i-clear w-6 h-6" />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {{ languages.COM_DELETE_ALL_IMAGES_QUESTION }}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {{ languages.COM_DELETE_ALL_IMAGES_EXPLANATION }}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction @click="deleteAllImages">
              {{ languages.COM_DELETE }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
import { useImageGeneration } from '@/assets/js/store/imageGeneration'
import { mapModeToLabel } from '@/lib/utils.ts'
import SideModalBase from '@/components/SideModalBase.vue'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

const conversations = useConversations()
const imageGeneration = useImageGeneration()

const props = defineProps<{
  mode: ModeType
  isVisible: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'conversationSelected'): void
}>()

function selectNewConversation() {
  const key = conversations.addNewConversation()
  if (!key) return
  conversations.activeKey = key
  emit('close')
}

function deleteAllImages() {
  if (props.mode !== 'chat') {
    imageGeneration.deleteAllImagesForMode(props.mode as WorkflowModeType)
  }
}
</script>
