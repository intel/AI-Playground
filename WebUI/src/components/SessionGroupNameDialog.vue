<template>
  <Dialog v-model:open="open">
    <DialogContent @click.stop>
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>
      <div class="mt-2 flex flex-col gap-1.5">
        <Input
          autofocus
          type="text"
          :maxlength="SESSION_NAME_MAX_LENGTH"
          :placeholder="languages.SESSIONS_GROUP_NAME_PLACEHOLDER"
          :aria-label="languages.SESSIONS_GROUP_NAME_PLACEHOLDER"
          :aria-invalid="error ? 'true' : undefined"
          :aria-describedby="errorId"
          v-model="name"
          @keydown.enter.prevent="submit"
        />
        <p :id="errorId" class="text-sm text-destructive" role="alert">{{ error }}</p>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ languages.COM_CANCEL }}</Button>
        <Button :disabled="saving" @click="submit">{{ submitLabel }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import type { GroupNameRefusal } from '@/assets/js/store/sessions'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { checkGroupName, type GroupNameProblem } from '@/lib/sessionGroupName'
import { SESSION_NAME_MAX_LENGTH, type SessionGroup } from '@/types/sessionIpc'

const props = defineProps<{
  title: string
  description: string
  submitLabel: string
  initialName: string
  /** Every Session Group, for the name check before main is asked. */
  groups: SessionGroup[]
  /** The Group being renamed, which may keep its own name. */
  ownId?: string
  save: (name: string) => Promise<GroupNameRefusal | null>
}>()

const open = defineModel<boolean>('open', { required: true })

const i18nState = useI18N().state
const errorId = useId()

const name = ref('')
const error = ref('')
const saving = ref(false)

watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    name.value = props.initialName
    error.value = ''
  },
  { immediate: true },
)

function messageOf(refusal: GroupNameRefusal): string {
  const messages: Partial<Record<GroupNameProblem, string>> = {
    blank: i18nState.SESSIONS_GROUP_NAME_BLANK,
    taken: i18nState.SESSIONS_GROUP_NAME_TAKEN,
  }
  return (refusal.problem && messages[refusal.problem]) || refusal.error
}

async function submit() {
  if (saving.value) return
  const check = checkGroupName(name.value, props.groups, props.ownId)
  if ('problem' in check && check.problem !== 'tooLong') {
    error.value = messageOf({ problem: check.problem, error: '' })
    return
  }
  saving.value = true
  try {
    const refusal = await props.save(name.value.trim())
    if (refusal) error.value = messageOf(refusal)
    else open.value = false
  } finally {
    saving.value = false
  }
}
</script>
