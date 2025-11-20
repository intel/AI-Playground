<template>
  <div
    id="chatHistoryPanel"
    :class="{ 'w-12': !isHistoryVisible, 'w-56': isHistoryVisible }"
    class="flex shrink-0 flex-col overflow-y-auto bg-gradient-to-r from-[#05010fb4]/20 to-[#05010fb4]/70 transition-all"
  >
    <div class="flex justify-end">
      <button @click="isHistoryVisible = !isHistoryVisible" class="m-2 flex text-foreground">
        <img
          v-if="!isHistoryVisible"
          :class="textInference.iconSizeClass"
          src="@/assets/svg/expand.svg"
          class="w-8 h-8"
        />
        <img
          v-else
          :class="textInference.iconSizeClass"
          src="@/assets/svg/collapse.svg"
          class="w-8 h-8"
        />
      </button>
    </div>
    <div v-if="isHistoryVisible" class="flex flex-col-reverse">
      <div
        v-for="(conversation, conversationKey) in conversations.conversationList"
        :key="'if' + conversationKey"
        @click="select(conversationKey)"
        :title="conversation?.[0]?.parts.find((part) => part.type === 'text')?.text.substring(0, 50) ?? languages.ANSWER_NEW_CONVERSATION"
        class="group relative cursor-pointer text-muted-foreground"
      >
        <div class="flex justify-between items-center w-full h-10 px-3">
          <div
            v-if="conversations.activeKey === conversationKey"
            class="absolute inset-1 bg-[#00c4fa]/50 rounded-lg"
          ></div>
          <div class="relative flex justify-between items-center w-full">
            <template v-if="conversations.isNewConversation(conversationKey)">
              <div
                class="flex items-center gap-2 px-2 py-1 rounded-md ml-1 transition-colors duration-150"
              >
                <PlusCircleIcon class="size-5" />
                <span class="text-sm">{{ languages.ANSWER_NEW_CONVERSATION }}</span>
              </div>
            </template>
            <template v-else>
              <span class="w-45 whitespace-nowrap overflow-x-auto text-ellipsis text-sm ml-1">
                {{ conversation?.[0]?.parts.find((part) => part.type === 'text')?.text.substring(0, 50) ?? languages.ANSWER_NEW_CONVERSATION }}
              </span>
            </template>
            <div v-if="!conversations.isNewConversation(conversationKey)">
              <DropdownMenu
                :open="menuOpenKey === conversationKey"
                @update:open="(open) => onMenuOpenChange(conversationKey, open)"
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    :class="[
                      'transition-opacity duration-100 ml-2 text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent focus:bg-transparent focus-visible:bg-transparent active:bg-transparent outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0',
                      menuOpenKey === conversationKey
                        ? 'opacity-70'
                        : 'opacity-0 group-hover:opacity-70',
                    ]"
                    @click.stop="() => {}"
                    @pointerdown.stop="() => {}"
                    @mousedown.stop
                  >
                    <EllipsisHorizontalIcon class="size-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  class="min-w-36"
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
                            openRenameDialog(conversationKey)
                          }
                        "
                      >
                        Rename
                      </DropdownMenuItem>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Rename conversation</DialogTitle>
                        <DialogDescription
                          >Set a new title for this conversation.</DialogDescription
                        >
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
                        <AlertDialogAction
                          @click="() => conversations.deleteConversation(conversationKey)"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="flex flex-col-reverse">
      <div
        v-for="(conversation, conversationKey) in conversations.conversationList"
        :key="'else' + conversationKey"
        :inVisibleKey="conversationKey"
        @click="select(conversationKey)"
        :title="(conversation?.[0]?.parts.find((part) => part.type === 'text')?.text?.substring(0, 50)) ?? languages.ANSWER_NEW_CONVERSATION"
        class="flex justify-between items-center h-12 py-2 cursor-pointer hover:bg-[#00c4fa]/50"
        :class="conversations.activeKey === conversationKey ? 'bg-[#00c4fa]/50' : ''"
      >
        <span
          v-if="conversationKey === currentlyGeneratingKey && processing"
          class="svg-icon i-loading w-8 h-8 animate-spin text-foreground flex items-center justify-center m-auto"
        ></span>
        <PlusCircleIcon
          v-else-if="conversations.isNewConversation(conversationKey)"
          class="m-auto size-8 text-muted-foreground"
        />
        <ChatBubbleLeftRightIcon v-else class="m-auto size-8 text-gray-300" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useConversations } from '@/assets/js/store/conversations'
import { useTextInference } from '@/assets/js/store/textInference'
import { Button } from '@/components/ui/button'
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
import {
  PlusCircleIcon,
  ChatBubbleLeftRightIcon,
  EllipsisHorizontalIcon,
} from '@heroicons/vue/24/outline'

const conversations = useConversations()
const textInference = useTextInference()
const isHistoryVisible = ref(false)

const menuOpenKey = ref<string | null>(null)
function onMenuOpenChange(conversationKey: string, open: boolean) {
  menuOpenKey.value = open
    ? conversationKey
    : menuOpenKey.value === conversationKey
      ? null
      : menuOpenKey.value
}

// State for rename dialog
const renameDialogOpen = ref(false)
const renameKey = ref<string | null>(null)
const renameTitle = ref('')

function openRenameDialog(conversationKey: string) {
  renameKey.value = conversationKey
  const existingTitle = conversations.conversationList[conversationKey]?.[0]?.parts.find((part) => part.type === 'text')?.text
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
  // conversations.renameConversationTitle(renameKey.value, newTitle)
  renameDialogOpen.value = false
  menuOpenKey.value = null
  renameKey.value = null
}

const props = defineProps<{
  onConversationClick: () => void
  currentlyGeneratingKey: string | null
  processing: boolean
}>()

function select(conversationKey: string) {
  console.log('Switching to conversationKey:', conversationKey)
  conversations.activeKey = conversationKey
  props.onConversationClick()
}
</script>