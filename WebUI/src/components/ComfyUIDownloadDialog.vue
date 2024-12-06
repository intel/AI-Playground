<template>
  <div v-if="componentState === ComponentState.USER_CONFIRMATION">
    <div ref="ComfyUIConfirmationdiv"
         class="bg-gray-600 max-w-md p-7 items-center justify-center rounded-lg shadow-lg  text-white">
      <form method="dialog" action="/submit" onsubmit="return false" class="items-center justify-center">
        <p class="mb-4">
          {{ languages.SETTINGS_MODEL_WORKFLOW_COMFYUI_CONFIRM }}
        </p>
        <div class="flex justify-between space-x-4 items-center">
          <button @click="() => {concludeDialog(false)}" type="submit" class="bg-slate-700 py-1 px-4 rounded">
            {{ languages.COM_CANCEL }}
          </button>
          <div class="flex-end space-x-4">
            <button @click="() => {onConfirm()}" type="submit" class="bg-color-active py-1 px-4 rounded">
              {{ languages.COM_CONFIRM }}
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
  <div v-else-if="componentState === ComponentState.INSTALLING">
    <div ref="ComfyUIConfirmationdiv"
         class="bg-gray-600 max-w-md p-7 items-center justify-center rounded-lg shadow-lg  text-white">
      <form method="dialog" action="/submit" onsubmit="return false" class="items-center justify-center">
        <p class="mb-4">
          {{ languages.SETTINGS_MODEL_WORKFLOW_COMFYUI_DOWNLOADING }}
        </p>
        <div class="flex justify-between space-x-4 items-center">
          <!--          <button @click="() => {}" type="submit" class="bg-slate-700 py-1 px-4 rounded">-->
          <!--            {{ languages.COM_CANCEL }}-->
          <!--          </button>-->
          <div class="flex-end space-x-4">
            <span class="svg-icon i-loading h-6 w-6"></span>
          </div>
        </div>
      </form>
    </div>
  </div>
  <div v-else-if="componentState === ComponentState.INSTALLATION_SUCCESS">
    <div ref="ComfyUIConfirmationdiv"
         class="bg-gray-600 max-w-md p-7 items-center justify-center rounded-lg shadow-lg  text-white">
      <form method="dialog" action="/submit" onsubmit="return false" class="items-center justify-center">
        <p class="mb-4">
          {{ languages.SETTINGS_MODEL_WORKFLOW_COMFYUI_COMPLETED }}
        </p>
        <div class="flex justify-between space-x-4 items-center">
          <button @click="() => {concludeDialog(true)}" type="submit" class="bg-slate-700 py-1 px-4 rounded">
            {{ languages.COM_CLOSE }}
          </button>
        </div>
      </form>
    </div>
  </div>
  <div v-else-if="componentState === ComponentState.ERROR">
    <div ref="ComfyUIConfirmationdiv"
         class="bg-gray-600 max-w-md p-7 items-center justify-center rounded-lg shadow-lg  text-white">
      <form method="dialog" action="/submit" onsubmit="return false" class="items-center justify-center">
        <p class="mb-4">
          {{ languages.SETTINGS_MODEL_WORKFLOW_COMFYUI_ERROR + installationErrorMessage }}
        </p>
        <div class="flex justify-between space-x-4 items-center">
          <button @click="() => {concludeDialog(false)}" type="submit" class="bg-slate-700 py-1 px-4 rounded">
            {{ languages.COM_CLOSE }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">

import {useGlobalSetup} from "@/assets/js/store/globalSetup.ts";
import {useImageGeneration} from "@/assets/js/store/imageGeneration.ts";
import {useComfyUi} from "@/assets/js/store/comfyUi.ts";


const comfyUi = useComfyUi()
const globalSetup = useGlobalSetup()
const imageGeneration = useImageGeneration()

enum ComponentState {
  USER_CONFIRMATION,
  INSTALLING,
  ERROR,
  INSTALLATION_SUCCESS
}

const componentState = ref(ComponentState.USER_CONFIRMATION)

const installationErrorMessage = ref("")

const emits = defineEmits<{
  (e: "close", success: boolean): void,
}>();

async function onConfirm() {
  componentState.value = ComponentState.INSTALLING
  try {
    await triggerInstallComfyUI()
    await triggerInstallCustomNodes()
    window.electronAPI.wakeupComfyUIService()
    setTimeout(() => {
      // TODO: should get proper feedback on server startup
      comfyUi.updateComfyState()
      componentState.value = ComponentState.INSTALLATION_SUCCESS
    }, 10000);
  } catch (error) {
    console.error('installation of comfyUI failed', {error})
    componentState.value = ComponentState.ERROR
    if (error instanceof Error) {
      installationErrorMessage.value = error.message;
    }
    return;
  }
}

async function triggerInstallComfyUI() {
  console.info("attempting to install comfyUI")
  const response = await fetch(`${globalSetup.apiHost}/api/comfyUi/install`, {method: 'POST'});
  if (response.status === 200) {
    console.info("comfyUI installation completed")
    return;
  }
  const data = await response.json();
  installationErrorMessage.value = data.error_message;
  throw new Error(data.error_message);
}

async function triggerInstallCustomNodes() {
  console.info("workflows:", imageGeneration.workflows.filter(w => w.backend === 'comfyui'))
  const uniqueCustomNodes = new Set(imageGeneration.workflows.filter(w => w.backend === 'comfyui').flatMap((item) => item.comfyUIRequirements.customNodes))

  const toBeInstalledCustomNodes: ComfyUICustomNodesRequestParameters[] = 
  [...uniqueCustomNodes].map((nodeName) => {
    const [username, repoName] = nodeName.replace(" ", "").split("/")
    return {username, repoName}
  })
  console.info("to be installed: ", toBeInstalledCustomNodes)
  const response = await fetch(`${globalSetup.apiHost}/api/comfyUi/loadCustomNodes`, {
    method: 'POST',
    body: JSON.stringify({data: toBeInstalledCustomNodes}),
    headers: {
      "Content-Type": "application/json"
    }
  })
  if (response.status === 200) {
    console.info("customNode installation completed")
    return;
  }
  const data = await response.json();
  throw new Error(data.error_message);
}

function concludeDialog(isInstallationSuccessful: boolean) {
  emits("close", isInstallationSuccessful)
  componentState.value = ComponentState.USER_CONFIRMATION
  installationErrorMessage.value = ""
}


</script>

<style scoped>

</style>