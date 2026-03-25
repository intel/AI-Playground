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
        <div
          v-if="warningDontShowAgainKey"
          class="flex items-center gap-2 self-start"
        >
          <input
            id="warning-dont-show-again"
            v-model="dontShowAgainChecked"
            type="checkbox"
            class="rounded border-border"
          />
          <label for="warning-dont-show-again" class="text-sm cursor-pointer">
            {{ i18nState.COM_DO_NOT_SHOW_AGAIN }}
          </label>
        </div>
        <div class="flex justify-center items-center gap-9">
          <button @click="cancelConfirm" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_CANCEL }}
          </button>
          <button @click="confirmAdd" class="bg-primary text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_CONFIRM }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useI18N } from '@/assets/js/store/i18n.ts'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { storeToRefs } from 'pinia'

const i18nState = useI18N().state
const dialogStore = useDialogStore()
const animate = ref(false)
const dontShowAgainChecked = ref(false)

const {
  warningMessage,
  warningConfirmFunction,
  warningDialogVisible,
  warningDontShowAgainKey,
} = storeToRefs(dialogStore)

watch(warningDialogVisible, (newValue) => {
  if (newValue) {
    dontShowAgainChecked.value = false
    animate.value = false
    nextTick(() => {
      animate.value = true
    })
  } else {
    animate.value = false
  }
})

function confirmAdd() {
  const fn = warningConfirmFunction.value
  if (warningDontShowAgainKey.value) {
    fn(dontShowAgainChecked.value)
  } else {
    fn()
  }
  dialogStore.closeWarningDialog()
}

function cancelConfirm() {
  dialogStore.closeWarningDialog()
}
</script>
