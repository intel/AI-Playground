<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ i18nState.DEMO_ENTER_TITLE }}</DialogTitle>
        <DialogDescription> {{ i18nState.DEMO_ENTER_DESC }} </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ i18nState.COM_CANCEL }}</Button>
        <Button @click="confirm">{{ i18nState.DEMO_ENTER_BUTTON }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useI18N } from '@/assets/js/store/i18n'

const i18nState = useI18N().state

const emit = defineEmits<{
  confirmed: []
}>()

const open = defineModel<boolean>('open', { required: true })

function confirm() {
  open.value = false
  emit('confirmed')
}
</script>
