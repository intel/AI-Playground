<template>
  <div
    class="flex items-start gap-2 rounded-lg px-3 py-2 transition cursor-pointer border-2 bg-muted hover:bg-muted/80"
    :class="active ? 'border-primary' : 'border-transparent'"
    role="button"
    tabindex="0"
    :aria-label="title"
    :aria-current="active ? 'true' : undefined"
    @click="emit('open')"
    @keydown.enter.self="emit('open')"
  >
    <div class="flex flex-col min-w-0 flex-1 gap-1">
      <span class="truncate text-sm text-foreground">{{ title }}</span>
      <span class="text-xs text-muted-foreground">{{ relativeTime(session.updatedAt) }}</span>
    </div>

    <DropdownMenu v-model:open="menuOpen">
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          class="h-6 w-6 flex-none"
          :aria-label="languages.SESSIONS_OPTIONS.replace('{title}', title)"
          @click.stop
        >
          <EllipsisVerticalIcon class="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        class="w-28"
        :onCloseAutoFocus="(event) => event.preventDefault?.()"
      >
        <Dialog v-model:open="renameOpen" @update:open="(open) => !open && (menuOpen = false)">
          <DialogTrigger as-child>
            <DropdownMenuItem
              @select="
                (event: Event) => {
                  event.preventDefault()
                  renameTitle = session.title
                }
              "
            >
              {{ languages.SESSIONS_RENAME }}
            </DropdownMenuItem>
          </DialogTrigger>
          <DialogContent @click.stop>
            <DialogHeader>
              <DialogTitle>{{ languages.SESSIONS_RENAME_TITLE }}</DialogTitle>
              <DialogDescription>{{ languages.SESSIONS_RENAME_DESCRIPTION }}</DialogDescription>
            </DialogHeader>
            <div class="mt-2">
              <Input
                autofocus
                type="text"
                :placeholder="languages.SESSIONS_RENAME_PLACEHOLDER"
                v-model="renameTitle"
                @keydown.enter.prevent="saveRename"
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" @click="renameOpen = false">{{
                languages.COM_CANCEL
              }}</Button>
              <Button :disabled="!renameTitle.trim()" @click="saveRename">{{
                languages.SESSIONS_SAVE
              }}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <AlertDialog>
          <AlertDialogTrigger as-child>
            <DropdownMenuItem @select="(event: Event) => event.preventDefault()">
              {{ languages.COM_DELETE }}
            </DropdownMenuItem>
          </AlertDialogTrigger>
          <AlertDialogContent @click.stop>
            <AlertDialogHeader>
              <AlertDialogTitle>{{ languages.SESSIONS_DELETE_TITLE }}</AlertDialogTitle>
              <AlertDialogDescription>{{ languages.SESSIONS_DELETE_BODY }}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel @click.stop>{{ languages.COM_CANCEL }}</AlertDialogCancel>
              <AlertDialogAction @click.stop="emit('delete')">
                {{ languages.COM_DELETE }}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { EllipsisVerticalIcon } from '@heroicons/vue/24/outline'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
import { useI18N } from '@/assets/js/store/i18n'
import { relativeTime } from '@/assets/js/store/historyEntries'
import type { SessionSummary } from '@/types/sessionIpc'

const props = defineProps<{
  session: SessionSummary
  active: boolean
}>()

const emit = defineEmits<{
  open: []
  rename: [title: string]
  delete: []
}>()

const i18nState = useI18N().state

const menuOpen = ref(false)
const renameOpen = ref(false)
const renameTitle = ref('')

const title = computed(() => props.session.title || i18nState.SESSIONS_UNTITLED)

function saveRename() {
  const next = renameTitle.value.trim()
  if (!next) return
  emit('rename', next)
  renameOpen.value = false
  menuOpen.value = false
}
</script>
