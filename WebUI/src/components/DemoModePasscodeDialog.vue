<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Enter Passcode</DialogTitle>
        <DialogDescription> A passcode is required to leave demo mode. </DialogDescription>
      </DialogHeader>
      <div class="flex flex-col gap-2 mt-2">
        <Input
          type="password"
          v-model="passcodeInput"
          placeholder="Passcode"
          :class="{ 'border-destructive': passcodeError }"
          @keydown.enter="confirmPasscode"
        />
        <div v-if="passcodeError" class="text-xs text-destructive">
          Incorrect passcode. Please try again.
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="open = false">Cancel</Button>
        <Button @click="confirmPasscode">Confirm</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const { verify } = defineProps<{
  verify: (input: string) => boolean
}>()

const emit = defineEmits<{
  confirmed: []
}>()

const open = defineModel<boolean>('open', { required: true })
const passcodeInput = ref('')
const passcodeError = ref(false)

watch(open, (isOpen) => {
  if (isOpen) {
    passcodeInput.value = ''
    passcodeError.value = false
  }
})

function confirmPasscode() {
  if (verify(passcodeInput.value)) {
    open.value = false
    emit('confirmed')
  } else {
    passcodeError.value = true
  }
}
</script>
