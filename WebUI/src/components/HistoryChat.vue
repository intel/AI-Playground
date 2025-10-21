<template>
  <div class="space-y-2 overflow-y-auto max-h-[100vh] pr-3">
    <div
      v-for="key in reversedConversationKeys"
      :key="key"
      class="flex items-center justify-between rounded-lg px-3 py-1 transition cursor-pointer border-2"
      :class="conversations.activeKey === key
    ? 'border-blue-500 bg-gray-700 hover:bg-gray-600'
    : 'border-transparent bg-gray-700 hover:bg-gray-600'"
      @click="selectConversation(key)"
    >
      <span class="truncate text-sm text-foreground">
        {{ conversations.conversationList[key]?.[0]?.title ?? languages.ANSWER_NEW_CONVERSATION }}
      </span>
      <DropdownMenu
        :open="menuOpenKey === key"
        @update:open="(open) => onMenuOpenChange(key, open)"
      >
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6" @click.stop>
            <span class="svg-icon i-dots-vertical w-4 h-4"></span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          class="w-28"
          :onCloseAutoFocus="
            (ev) => {
              ev.preventDefault?.()
            }
          "
        >
          <Dialog
            v-model:open="renameDialogOpen"
            @update:open="
              (open) => {
                if (!open) menuOpenKey = null
              }
            "
          >
            <DialogTrigger asChild>
              <DropdownMenuItem
                @select="
                  (e: Event) => {
                    e.preventDefault()
                    openRenameDialog(key)
                  }
                "
              >
                Rename
              </DropdownMenuItem>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Rename conversation</DialogTitle>
                <DialogDescription>Set a new title for this conversation.</DialogDescription>
              </DialogHeader>
              <div class="mt-2">
                <Input
                  autofocus
                  type="text"
                  placeholder="Enter title"
                  v-model="renameTitle"
                  @keydown.enter.prevent="saveRename"
                />
              </div>
              <DialogFooter>
                <Button variant="ghost" @click="cancelRename">Cancel</Button>
                <Button :disabled="!renameTitle.trim()" @click="saveRename">Save</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <DropdownMenuItem @select="(e: Event) => e.preventDefault()">
                Delete
              </DropdownMenuItem>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently remove this conversation and its messages.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction @click="() => conversations.deleteConversation(key)">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useConversations } from '@/assets/js/store/conversations'

const conversations = useConversations()
const emits = defineEmits<{
  (e: 'conversationSelected'): void
}>()

const reversedConversationKeys = computed(() => {
  const list = conversations.conversationList ?? {}
  const keys = Object.keys(list).reverse()
  keys.shift()
  return keys
})

const menuOpenKey = ref<string | null>(null)

function onMenuOpenChange(conversationKey: string, open: boolean) {
  menuOpenKey.value = open
    ? conversationKey
    : menuOpenKey.value === conversationKey
      ? null
      : menuOpenKey.value
}

// Rename dialog state
const renameDialogOpen = ref(false)
const renameKey = ref<string | null>(null)
const renameTitle = ref('')

function openRenameDialog(conversationKey: string) {
  renameKey.value = conversationKey
  const existingTitle = conversations.conversationList[conversationKey]?.[0]?.title
  renameTitle.value = existingTitle ?? ''
  renameDialogOpen.value = true
}

function cancelRename() {
  renameDialogOpen.value = false
  renameKey.value = null
  menuOpenKey.value = null
}

function saveRename() {
  if (!renameKey.value) return
  const newTitle = renameTitle.value.trim()
  if (newTitle.length === 0) return
  conversations.renameConversationTitle(renameKey.value, newTitle)
  renameDialogOpen.value = false
  menuOpenKey.value = null
  renameKey.value = null
}

const selectConversation = (key: string) => {
  conversations.activeKey = key
  console.log('Selected conversation:', key)
  emits('conversationSelected')
}
</script>

<style scoped>
</style>
