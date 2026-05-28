<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ i18nState.DEMO_PASSCODE_TITLE }}</DialogTitle>
        <DialogDescription> {{ i18nState.DEMO_PASSCODE_DESC }} </DialogDescription>
      </DialogHeader>
      <div class="flex flex-col gap-2 mt-2">
        <Input
          type="password"
          v-model="passcodeInput"
          :placeholder="i18nState.DEMO_PASSCODE_PLACEHOLDER"
          :class="{ 'border-destructive': passcodeError }"
          @keydown.enter="confirmPasscode"
        />
        <div v-if="passcodeError" class="text-xs text-destructive">
          {{ i18nState.DEMO_PASSCODE_ERROR }}
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ i18nState.COM_CANCEL }}</Button>
        <Button @click="confirmPasscode">{{ i18nState.COM_CONFIRM }}</Button>
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
import { useI18N } from '@/assets/js/store/i18n'

const i18nState = useI18N().state

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
