<template>
  <Dialog :open="true">
    <DialogContent class="z-[var(--demo-z-dialog)]">
      <DialogHeader>
        <DialogTitle>{{ i18nState.DEMO_AUTORESET_TITLE }}</DialogTitle>
        <DialogDescription>
          {{ i18nState.DEMO_AUTORESET_DESC }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="reset"
          >{{ i18nState.DEMO_AUTORESET_RESET }} ({{ countdown }})</Button
        >
        <Button @click="stay">{{ i18nState.COM_STAY }}</Button>
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
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useI18N } from '@/assets/js/store/i18n'
import { ref, onMounted, onUnmounted } from 'vue'

const demoMode = useDemoMode()
const i18nState = useI18N().state

const COUNTDOWN_SECONDS = 10

const countdown = ref(COUNTDOWN_SECONDS)
let countdownInterval: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  countdownInterval = setInterval(() => {
    countdown.value--
    if (countdown.value <= 0) {
      reset()
    }
  }, 1000)
})

onUnmounted(() => {
  if (countdownInterval) {
    clearInterval(countdownInterval)
    countdownInterval = null
  }
})

function stay() {
  demoMode.cancelReset()
}

function reset() {
  demoMode.resetDemo()
}
</script>
