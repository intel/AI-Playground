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
  <div v-else-if="componentState === ComponentState.DOWNLOADING">
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

const globalSetup = useGlobalSetup()
const imageGenerationSettings = useImageGeneration()

enum ComponentState {
  UNINITIALIZED,
  USER_CONFIRMATION,
  DOWNLOADING,
  ERROR,
  INSTALLATION_SUCCESS
}

const componentState = ref(ComponentState.USER_CONFIRMATION)

const installationErrorMessage = ref("")

const emits = defineEmits<{
  (e: "close", success: boolean): void,
}>();

function onConfirm() {
  componentState.value = ComponentState.DOWNLOADING
  console.info("attempting to install comfyUI")
  triggerInstallComfyUI().then(value => {
    console.log(value)
    if (value.status === 200) {
      console.info("comfyUI installation completed")
      triggerInstallCustomNodes().then(value => {
        if (value.status === 200) {
          console.info("customNode installation completed")
          componentState.value = ComponentState.INSTALLATION_SUCCESS
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
  const uniqueCustomNodes = new Set(imageGenerationSettings.workflows.filter(w => w.backend === 'comfyui').flatMap((item) => item.comfyUIRequirements.customNodes))
  const toBeInstalledCustomNodes = []
  for (nodeName in uniqueCustomNodes) {
    const [username, repoName] = nodeName.replace(" ", "").split("/")
    const nodeID = ComfyUICustomNodesRequestParameters(username, repoName)
    toBeInstalledCustomNodes.push(nodeID)
  }
  const response = fetch(`${globalSetup.apiHost}/api/comfy-ui/load_custom_nodes`, {
    method: 'POST',
    body: JSON.stringify(toRaw({'data': toBeInstalledCustomNodes})),
    headers: {
      "Content-Type": "application/json"
    }
  })
  return reponse
}

function concludeDialog(isInstallationSuccessful: boolean) {
  emits("close", isInstallationSuccessful)
  componentState.value = ComponentState.USER_CONFIRMATION
  installationErrorMessage.value = ""
}

</script>

<style scoped>

</style>