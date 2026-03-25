<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Enter Demo Mode?</DialogTitle>
        <DialogDescription> A passcode may be required to leave demo mode. </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="open = false">Cancel</Button>
        <Button @click="confirm">Enter Demo Mode</Button>
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

const emit = defineEmits<{
  confirmed: []
}>()

const open = defineModel<boolean>('open', { required: true })

function confirm() {
  open.value = false
  emit('confirmed')
}
</script>
