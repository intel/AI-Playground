<template>
  <div class="flex flex-col gap-3 pt-6 border-t border-border mt-4">
    <div class="flex justify-between pr-4 items-center gap-4">
      <Label class="whitespace-nowrap">Demo Mode</Label>
      <Button id="demo-mode-toggle" variant="destructive" size="sm" @click="handleClick">
        {{ demoMode.enabled ? 'Leave' : 'Enter' }}
      </Button>
    </div>
  </div>
  <DemoModePasscodeDialog
    v-model:open="passcodeDialogOpen"
    :verify="demoMode.verifyPasscode"
    @confirmed="demoMode.setEnabled(false)"
  />
  <DemoModeEnterConfirmDialog
    v-model:open="confirmEnterOpen"
    @confirmed="demoMode.setEnabled(true)"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { useDemoMode } from '@/assets/js/store/demoMode'
import DemoModePasscodeDialog from '@/components/DemoModePasscodeDialog.vue'
import DemoModeEnterConfirmDialog from '@/components/DemoModeEnterConfirmDialog.vue'

const demoMode = useDemoMode()
const passcodeDialogOpen = ref(false)
const confirmEnterOpen = ref(false)

function handleClick() {
  if (demoMode.enabled) {
    passcodeDialogOpen.value = true
  } else {
    confirmEnterOpen.value = true
  }
}
</script>
