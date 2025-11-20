<template>
  <div class="flex flex-col space-y-2 pr-3 h-full overflow-y-auto">
    <div
      v-for="key in reversedConversationKeys"
      :key="key"
      class="flex flex-col items-center justify-between rounded-lg px-3 py-1 transition cursor-pointer border-2"
      :class="
        conversations.activeKey === key
          ? 'border-primary bg-muted hover:bg-muted/80'
          : 'border-transparent bg-muted hover:bg-muted/80'
      "
      @click="selectConversation(key)"
    >
      <div class="flex items-center justify-between w-full">
        <span class="truncate text-sm text-foreground">
          {{ conversationTitle(key) }}
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
      <div
        v-if="images(conversations.conversationList[key]).length > 0"
        class="flex p-2 overflow-hidden justify-end self-start"
      >
        <img
          v-for="(img, i) in images(conversations.conversationList[key])"
          :key="img.id"
          :src="img.imageUrl"
          class="w-12 h-12 rounded-sm shadow-black shadow-md border-3 border-background"
          :style="{
            marginLeft: `-${overlap(i, images(conversations.conversationList[key]).length)}px`,
          }"
        />
      </div>
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
import { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'

const conversations = useConversations()
const emits = defineEmits<{
  (e: 'conversationSelected'): void
}>()

const images = (conversation: AipgUiMessage[]) => {
  return conversation.flatMap((msg, msgIndex) =>
    msg.parts
      .filter((part) => part.type === 'tool-comfyUI' && part.state === 'output-available')
      .map((part, partIndex) => {
        if (part.type === 'tool-comfyUI' && 'output' in part && part.output && typeof part.output === 'object' && 'images' in part.output) {
          const images = (part.output as { images?: Array<{ imageUrl?: string }> }).images ?? []
          return images.map((img, imgIndex) => ({
            id: `${msgIndex}-${partIndex}-${imgIndex}`,
            imageUrl: img.imageUrl ?? '',
          }))
        }
        return []
      })
      .flat()
      .filter((img): img is { id: string; imageUrl: string } => 
        img !== null && 
        img !== undefined && 
        'imageUrl' in img && 
        typeof img.imageUrl === 'string' && 
        img.imageUrl.trim() !== '' &&
        'id' in img &&
        typeof img.id === 'string'
      ),
  )
}

const overlap = (i: number, length: number) => {
  if (i === 0) return 0
  const reversed = length - i
  // overlap should be 1 for the last 4 images and then increase by 1 for each image before that up to 8
  const overlap = Math.min(Math.max(4, reversed), 8)
  console.log('overlap', i, length, overlap)
  return 4 * overlap
}

const reversedConversationKeys = computed(() => {
  const list = conversations.conversationList ?? {}
  const keys = Object.keys(list).reverse()
  console.log('Reversed conversation keys:', list, keys)
  return keys
})

const conversationTitle = (key: string) => {
  const conversation = conversations.conversationList[key]
  if (!conversation || conversation.length === 0) {
    return 'New Conversation'
  }
  if (conversation[0].metadata?.conversationTitle) {
    return conversation[0].metadata.conversationTitle
  }
  const firstMessage = conversation[0]

  // todo: can be deleted eventually
  if (firstMessage.parts === undefined) {
    conversations.deleteConversation(key)
  }

  const titlePart = firstMessage.parts?.find((part) => part.type === 'text')
  return titlePart ? titlePart.text.substring(0, 50) : 'New Conversation'
}

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
  const existingTitle = conversationTitle(conversationKey)
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

<style scoped></style>
