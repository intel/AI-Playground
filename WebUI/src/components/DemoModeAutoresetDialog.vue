<template>
  <Dialog :open="true">
    <DialogContent class="z-[var(--demo-z-dialog)]">
      <DialogHeader>
        <DialogTitle>Demo Session Timeout</DialogTitle>
        <DialogDescription>
          This demo session will soon reset due to inactivity. Do you want to stay?
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="reset">Reset ({{ countdown }})</Button>
        <Button @click="stay">Stay</Button>
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
import { ref, onMounted, onUnmounted } from 'vue'

const demoMode = useDemoMode()

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
