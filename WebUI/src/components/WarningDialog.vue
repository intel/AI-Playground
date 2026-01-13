<template>
  <div class="dialog-container z-10">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/55 flex justify-center items-center"
    >
      <div
        class="py-10 px-20 w-500px flex flex-col items-center justify-center bg-card rounded-3xl gap-6 text-foreground"
        :class="{ 'animate-scale-in': animate }"
      >
        <p v-html="warningMessage"></p>
        <div class="flex justify-center items-center gap-9">
          <button @click="cancelConfirm" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_CANCEL }}
          </button>
          <button @click="confirmAdd" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_CONFIRM }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18N } from '@/assets/js/store/i18n.ts'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { storeToRefs } from 'pinia'

const i18nState = useI18N().state
const dialogStore = useDialogStore()
const animate = ref(false)

const { warningMessage, warningConfirmFunction, warningDialogVisible } = storeToRefs(dialogStore)

watch(warningDialogVisible, (newValue) => {
  if (newValue) {
    animate.value = false
    nextTick(() => {
      animate.value = true
    })
  } else {
    animate.value = false
  }
})

function confirmAdd() {
  warningConfirmFunction.value()
  dialogStore.closeWarningDialog()
}

function cancelConfirm() {
  dialogStore.closeWarningDialog()
}
</script>
