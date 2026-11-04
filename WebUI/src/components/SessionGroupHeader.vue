<template>
  <div class="flex items-center gap-1 min-w-0">
    <Button
      variant="ghost"
      class="h-7 flex-1 min-w-0 justify-start gap-1 px-1 text-sm font-medium text-foreground"
      :aria-expanded="expanded"
      :aria-controls="controls"
      @click="emit('toggle', !expanded)"
    >
      <ChevronDownIcon v-if="expanded" class="size-4 flex-none" aria-hidden="true" />
      <ChevronRightIcon v-else class="size-4 flex-none" aria-hidden="true" />
      <span class="truncate">{{ group.name }}</span>
    </Button>

    <DropdownMenu v-model:open="menuOpen">
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          class="h-6 w-6 flex-none"
          :aria-label="languages.SESSIONS_GROUP_OPTIONS.replace('{name}', group.name)"
        >
          <EllipsisVerticalIcon class="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="min-w-28">
        <DropdownMenuItem @select="emit('newSession')">
          {{ languages.SESSIONS_NEW_SESSION_HERE }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="openRename">
          {{ languages.SESSIONS_RENAME_GROUP }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="deleteOpen = true">
          {{ languages.SESSIONS_DELETE_GROUP }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <Dialog v-model:open="renameOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ languages.SESSIONS_RENAME_GROUP }}</DialogTitle>
          <DialogDescription>{{ languages.SESSIONS_RENAME_GROUP_DESCRIPTION }}</DialogDescription>
        </DialogHeader>
        <div class="mt-2 flex flex-col gap-1.5">
          <Input
            autofocus
            type="text"
            :maxlength="SESSION_NAME_MAX_LENGTH"
            :placeholder="languages.SESSIONS_GROUP_NAME_PLACEHOLDER"
            :aria-label="languages.SESSIONS_GROUP_NAME_PLACEHOLDER"
            :aria-invalid="renameError ? 'true' : undefined"
            :aria-describedby="errorId"
            v-model="renameName"
            @keydown.enter.prevent="saveRename"
          />
          <p :id="errorId" class="text-sm text-destructive" role="alert">{{ renameError }}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="renameOpen = false">{{ languages.COM_CANCEL }}</Button>
          <Button @click="saveRename">{{ languages.SESSIONS_SAVE }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ languages.SESSIONS_DELETE_GROUP_TITLE }}</AlertDialogTitle>
          <AlertDialogDescription>{{
            languages.SESSIONS_DELETE_GROUP_BODY
          }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ languages.COM_CANCEL }}</AlertDialogCancel>
          <AlertDialogAction @click="emit('delete')">{{ languages.COM_DELETE }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<script setup lang="ts">
import { ref, useId } from 'vue'
import { ChevronDownIcon, ChevronRightIcon, EllipsisVerticalIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { SESSION_NAME_MAX_LENGTH, type SessionGroup } from '@/types/sessionIpc'

const props = defineProps<{
  group: SessionGroup
  /** Every Session Group, for the rename's name check. */
  groups: SessionGroup[]
  expanded: boolean
  /** Id of the element holding the Group's rows. */
  controls: string
}>()

const emit = defineEmits<{
  toggle: [expanded: boolean]
  rename: [name: string]
  delete: []
  newSession: []
}>()

const i18nState = useI18N().state
const errorId = useId()

const menuOpen = ref(false)
const renameOpen = ref(false)
const renameName = ref('')
const renameError = ref('')
const deleteOpen = ref(false)

function openRename() {
  renameName.value = props.group.name
  renameError.value = ''
  renameOpen.value = true
}

function saveRename() {
  const name = renameName.value.trim()
  const taken = name.toLocaleLowerCase()
  if (!name) renameError.value = i18nState.SESSIONS_GROUP_NAME_BLANK
  else if (
    props.groups.some(
      (group) => group.id !== props.group.id && group.name.toLocaleLowerCase() === taken,
    )
  ) {
    renameError.value = i18nState.SESSIONS_GROUP_NAME_TAKEN
  } else {
    if (name !== props.group.name) emit('rename', name)
    renameOpen.value = false
  }
}
</script>
