<template>
  <div class="bg-gray-600 max-w-md p-7 items-center justify-center rounded-lg shadow-lg  text-white">
    <p class="mb-4">
      {{ languages.SETTINGS_MODEL_WORKFLOW_COMFYUI_CONFIRM }}
    </p>
    <div class="flex justify-between space-x-4 items-center">
      <button @click="() => {concludeDialog()}" type="submit" class="bg-slate-700 py-1 px-4 rounded">
        {{ languages.COM_CANCEL }}
      </button>
      <div class="flex-end space-x-4">
        <button @click="() => {onConfirm()}" type="submit" class="bg-color-active py-1 px-4 rounded">
          {{ "Go to Setup" }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">

import {useGlobalSetup} from "@/assets/js/store/globalSetup.ts";

const globalSetup = useGlobalSetup()

const emits = defineEmits<{
  (e: "close"): void,
}>();

async function onConfirm() {
  globalSetup.loadingState = 'manageInstallations';
}

function concludeDialog() {
  emits("close")
}

</script>
