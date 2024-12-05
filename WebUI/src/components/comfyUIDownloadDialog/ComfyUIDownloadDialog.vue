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
import {ipcRenderer} from "electron";


const globalSetup = useGlobalSetup()
const imageGenerationSettings = useImageGeneration()

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

function onConfirm() {
  componentState.value = ComponentState.INSTALLING
  console.info("attempting to install comfyUI")
  triggerInstallComfyUI().then(value => {
    if (value.status === 200) {
      console.info("comfyUI installation completed")
      triggerInstallCustomNodes().then(value => {
        if (value.status === 200) {
          console.info("customNode installation completed")
          triggerWakeUpComfyUIProcess().then(() => {
                setTimeout(() => {
                  //requires proper feedback on server startup...
                  componentState.value = ComponentState.INSTALLATION_SUCCESS
                }, 3000);
          })
        } else {
          const data = value.json();
          data.then(response => {
            componentState.value = ComponentState.ERROR
            console.error('installation of comfyUI failed')
            if (value.status === 501) {
              installationErrorMessage.value = response.error_message;
            }
          })
        }
      })
    } else {
      const data = value.json();
      data.then(response => {
        componentState.value = ComponentState.ERROR
        console.error('installation of comfyUI failed')
        if (value.status === 501) {
          installationErrorMessage.value = response.error_message;
        }
      })
    }
  })
}

function triggerInstallComfyUI() {
  return fetch(`${globalSetup.apiHost}/api/comfy-ui/install`, {method: 'POST'});
}

function triggerInstallCustomNodes() {
  console.info("workflows:", imageGenerationSettings.workflows.filter(w => w.backend === 'comfyui'))
  const uniqueCustomNodes = new Set(imageGenerationSettings.workflows.filter(w => w.backend === 'comfyui').flatMap((item) => item.comfyUIRequirements.customNodes))

  const toBeInstalledCustomNodes: ComfyUICustomNodesRequestParameters[] = []
  console.info("custom nodes", uniqueCustomNodes)
  for (var nodeName of uniqueCustomNodes) {
    const [username, repoName] = nodeName.replace(" ", "").split("/")
    const nodeID: ComfyUICustomNodesRequestParameters = {username: username, repoName: repoName}
    toBeInstalledCustomNodes.push(nodeID)
  }
  console.info("to be  installed: ", toBeInstalledCustomNodes)
  const response = fetch(`${globalSetup.apiHost}/api/comfy-ui/load_custom_nodes`, {
    method: 'POST',
    body: JSON.stringify(toRaw({'data': toBeInstalledCustomNodes})),
    headers: {
      "Content-Type": "application/json"
    }
  })
  return response
}

async function triggerWakeUpComfyUIProcess() {
  window.electronAPI.wakeupComfyUIService()
}

function concludeDialog(isInstallationSuccessful: boolean) {
  emits("close", isInstallationSuccessful)
  componentState.value = ComponentState.USER_CONFIRMATION
  installationErrorMessage.value = ""
}


</script>

<style scoped>

</style>