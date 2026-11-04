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
        <DropdownMenuItem @select="renameOpen = true">
          {{ languages.SESSIONS_RENAME_GROUP }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="deleteOpen = true">
          {{ languages.SESSIONS_DELETE_GROUP }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <SessionGroupNameDialog
      v-model:open="renameOpen"
      :title="languages.SESSIONS_RENAME_GROUP"
      :description="languages.SESSIONS_RENAME_GROUP_DESCRIPTION"
      :submit-label="languages.SESSIONS_SAVE"
      :initial-name="group.name"
      :groups
      :own-id="group.id"
      :save="saveRename"
    />

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
import { ref } from 'vue'
import { ChevronDownIcon, ChevronRightIcon, EllipsisVerticalIcon } from '@heroicons/vue/24/outline'
import type { GroupNameRefusal } from '@/assets/js/store/sessions'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import SessionGroupNameDialog from '@/components/SessionGroupNameDialog.vue'
import type { SessionGroup } from '@/types/sessionIpc'

const props = defineProps<{
  group: SessionGroup
  /** Every Session Group, for the rename's name check. */
  groups: SessionGroup[]
  expanded: boolean
  /** Id of the element holding the Group's rows. */
  controls: string
  rename: (name: string) => Promise<GroupNameRefusal | null>
}>()

const emit = defineEmits<{
  toggle: [expanded: boolean]
  delete: []
  newSession: []
}>()

const menuOpen = ref(false)
const renameOpen = ref(false)
const deleteOpen = ref(false)

async function saveRename(name: string): Promise<GroupNameRefusal | null> {
  return name === props.group.name ? null : props.rename(name)
}
</script>
