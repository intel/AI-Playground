<template>
  <SideModalBase
    :is-visible="isVisible"
    :title="languages.COM_HISTORY"
    side="left"
    @close="$emit('close')"
  >
    <template #header-buttons>
      <!-- Clear-all only ever meant "delete this mode's generated media". -->
      <AlertDialog v-if="showClearMedia">
        <AlertDialogTrigger asChild>
          <button class="svg-icon i-clear w-6 h-6" :title="languages.COM_CLEAR_HISTORY" />
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
            <AlertDialogAction @click="history.clearCurrentModeMedia()">
              {{ languages.COM_DELETE }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <!-- "New" follows the mode: a new game or agent conversation, a new chat
           thread, a blank canvas. -->
      <button @click="history.startNew()" class="svg-icon i-add w-7 h-7" :title="newTitle" />
    </template>

    <HistoryList @selected="onSelected" />
  </SideModalBase>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import SideModalBase from '@/components/SideModalBase.vue'
import HistoryList from '@/components/HistoryList.vue'
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
import { useHistorySessions } from '@/assets/js/store/historySessions'
import { isWorkflowMode, type HistoryEntry } from '@/assets/js/store/historyEntries'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useI18N } from '@/assets/js/store/i18n'

defineProps<{
  isVisible: boolean
}>()

const emit = defineEmits<{
  close: []
  conversationSelected: []
}>()

const history = useHistorySessions()
const agentMode = useAgentMode()
const i18nState = useI18N().state

const showClearMedia = computed(
  () => history.filter === 'current' && isWorkflowMode(history.currentMode),
)

const newTitle = computed(() =>
  history.currentMode === 'agent' && agentMode.agentWorkspaceKind === 'games'
    ? 'New game'
    : i18nState.COM_ADD,
)

function onSelected(entry: HistoryEntry) {
  if (entry.kind === 'conversation') emit('conversationSelected')
}
</script>
