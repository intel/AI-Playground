<template>
  <div class="z-10 text-white rounded-xl bg-black/70">
    <div class="px-20 py-5 max-w-5xl">
      <h1 class="text-center py-1 px-4 rounded text-4xl">
        {{ languages.BACKEND_MANAGE }}</h1>
      <div class="">
        <p class="text-lg text-left pt-3 pb-3"> {{ languages.BACKEND_REQUIRED_COMPONENTS_MESSAGE }} </p>
        <p class="text-lg text-left pt-3 pb-7"> {{ languages.BACKEND_OPTIONAL_COMPONENTS_MESSAGE }} </p>
        <table class="text-center w-full" style="table-layout: fixed;">
          <thead>
          <tr class="font-bold">
            <td style="text-align: left">{{ languages.BACKEND_SINGLE_COMPONENT }}</td>
            <td>{{ languages.BACKEND_TYPE }}</td>
            <td>{{ languages.BACKEND_INFORMATION }}</td>
            <td>{{ languages.BACKEND_ENABLE }}</td>
            <td>{{ languages.BACKEND_STATUS }}</td>
            <td>{{ languages.BACKEND_ACTION }}</td>
          </tr>
          </thead>
          <tbody>
          <tr v-for="component in components">
            <td class="text-left">{{ mapServiceNameToDisplayName(component.serviceName) }}</td>
            <td class="text-center">{{ component.isRequired ? "Required" : "Optional" }}</td>
            <td>
              <a :href="getInfoURL(component.serviceName)" target="_blank">
              <span v-show="!!getInfoURL(component.serviceName)" style="vertical-align: middle;"
                    class="svg-icon i-info w-7 h-7 px-6"></span>
              </a>
              <p v-show="!getInfoURL(component.serviceName)"> - </p>
            </td>
            <td>
              <button v-if="component.status !== 'running' && !component.isLoading"
                      class="v-checkbox-control-table flex-none w-5 h-5"
                      :class="{ 'v-checkbox-checked-table': component.enabled}"
                      @click="() => {
                        if (component.enabled && !component.isSetUp) {
                          toBeInstalledComponents.delete(component.serviceName)
                        } else {
                          toBeInstalledComponents.add(component.serviceName)
                        }}"
                      :disabled="component.isRequired">
              </button>
              <p v-else> - </p>
            </td>
            <td :style="{ color: mapStatusToColor(component.status) }">{{ mapToDisplayStatus(component.status) }}</td>
            <td>
              <span v-if="component.isLoading" class="svg-icon i-loading flex-none w-5 h-5"></span>
              <button v-else-if="component.status === 'notInstalled' && !component.isSetUp"
                      @click="() => installBackend(component.serviceName)"
                      :disabled="!component.enabled || isSomethingLoading()"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_INSTALL }}
              </button>
              <button v-else-if="component.status === 'failed' || component.status === 'installationFailed'"
                      @click="() => repairBackend(component.serviceName)"
                      :disabled="!component.enabled || isSomethingLoading()"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_REPAIR }}
              </button>
              <button v-else-if="component.status === 'running'" @click="() => restartBackend(component.serviceName)"
                      :disabled="isSomethingLoading()"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_RESTART }}
              </button>
              <button v-else-if="component.status === 'stopped' || component.status === 'notYetStarted'"
                      @click="() => restartBackend(component.serviceName)"
                      :disabled="isSomethingLoading()"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_START }}
              </button>

              <p v-else> - </p>
            </td>
          </tr>
          </tbody>
        </table>
      </div>

      <!-- close/install all//continue -->
      <div class="dialog-container flex justify-between z-10 pt-10" style="display: flex">
        <button :style="{visibility: convertVisibility(!somethingChanged)}" :disabled="!CanCloseInstallations()"
                @click="closeInstallations"
                class="flex bg-color-active py-1 px-4 rounded">{{
            languages.COM_CLOSE
          }}
        </button>
        <button :disabled="!areBoxesChecked() || isSomethingLoading() || isEverythingRunning()"
                @click="installAllSelected"
                class="flex bg-color-active py-1 px-4 rounded">{{
            languages.COM_INSTALL_ALL
          }}
        </button>
        <button :style="{visibility: convertVisibility(somethingChanged)}" :disabled="!CanCloseInstallations()"
                @click="closeInstallations"
                class="flex bg-color-active py-1 px-4 rounded">{{
            languages.COM_CONTINUE
          }}
        </button>
      </div>

      <!-- terms and conditions -->
      <div class="dialog-container z-10 pt-10" style="display: flex">
        <p>{{ languages.BACKEND_TERMS_AND_CONDITIONS }}</p>
      </div>
      <!-- Change Language Settings -->
      <div class="place-content-end flex gap-2">
        <drop-selector :array="i18n.languageOptions" @change="i18n.changeLanguage" class="max-w-40">
          <template #selected>
            <div class="flex gap-2 items-center">
              <span class="rounded-full bg-green-500 w-2 h-2"></span>
              <span>{{ i18n.currentLanguageName }}</span>
            </div>
          </template>
          <template #list="slotItem">
            <div class="flex gap-2 items-center">
              <span class="rounded-full bg-green-500 w-2 h-2"></span>
              <span>{{ slotItem.item.name }}</span>
            </div>
          </template>
        </drop-selector>
      </div>
    </div>
  </div>


</template>

<script setup lang="ts">
import {mapServiceNameToDisplayName, mapStatusToColor, mapToDisplayStatus} from "@/lib/utils.ts";
import {toast} from "@/assets/js/toast.ts";
import {useBackendServices} from '@/assets/js/store/backendServices';
import DropSelector from "@/components/DropSelector.vue";
import {useI18N} from '@/assets/js/store/i18n';

const emits = defineEmits<{
  (e: "close"): void
}>();


type ExtendedApiServiceInformation = ApiServiceInformation & { enabled: boolean, isLoading: boolean }

const backendServices = useBackendServices();
const i18n = useI18N();

let toBeInstalledQueue: ExtendedApiServiceInformation[] = []

const loadingComponents = ref(new Set<string>());

const somethingChanged = ref(false)

const alreadyInstalledOrRequiredComponents = computed(() => new Set(backendServices.info.filter((item) => item.isSetUp || item.isRequired).map((item) => item.serviceName)))
const toBeInstalledComponents = ref(new Set<BackendServiceName>())

const components = computed(() => {return backendServices.info.map((item) => ({
  enabled: alreadyInstalledOrRequiredComponents.value.has(item.serviceName) || toBeInstalledComponents.value.has(item.serviceName),
  isLoading: loadingComponents.value.has(item.serviceName),
  ...item
}))})


function isSomethingLoading(): boolean {
  return components.value.some((item) => item.isLoading)
}

async function installBackend(name: BackendServiceName) {
  somethingChanged.value = true;
  loadingComponents.value.add(name)
  const setupProgress = await backendServices.setUpService(name)
  if (setupProgress.success) {
    await restartBackend(name)
  } else {
    toast.error("Setup failed")
    loadingComponents.value.delete(name)
  }
}

async function repairBackend(name: BackendServiceName) {
  loadingComponents.value.add(name)
  const stopStatus = await backendServices.stopService(name)
  if (stopStatus !== 'stopped') {
    toast.error("Service failed to stop")
    return
  }
  await installBackend(name);
}

async function restartBackend(name: BackendServiceName) {
  loadingComponents.value.add(name)
  const stopStatus = await backendServices.stopService(name)
  if (stopStatus !== 'stopped') {
    toast.error("Service failed to stop")
    loadingComponents.value.delete(name)
    return
  }

  const startStatus = await backendServices.startService(name)
  if (startStatus !== 'running') {
    toast.error("Service failed to restart")
    loadingComponents.value.delete(name)
    return
  }

  loadingComponents.value.delete(name)
}

async function installAllSelected() {
  toBeInstalledQueue = components.value.filter(item => item.enabled && (item.status === 'notInstalled' || item.status === 'failed' || item.status === 'installationFailed'));
  toBeInstalledQueue.forEach((item) => loadingComponents.value.add(item.serviceName))
  for (const component of toBeInstalledQueue) {
    if (component.status === 'failed' || component.status == "installationFailed") {
      await repairBackend(component.serviceName);
    } else {
      await installBackend(component.serviceName);
    }
  }
}

function closeInstallations() {
  emits("close");
}

function getInfoURL(serviceName: string) {
  switch (serviceName) {
    case "ai-backend":
      return "https://github.com/intel/ai-playground"
    case "comfyui-backend":
      return "https://github.com/comfyanonymous/ComfyUI"
    case "llamacpp-backend":
      return "https://github.com/abetlen/llama-cpp-python"
    default:
      return undefined
  }
}

function CanCloseInstallations() {
  return components.value.every((i) => i.status === 'running' || !i.isRequired)
}

function isEverythingRunning() {
  return components.value.every((i) => i.status === 'running')
}

function areBoxesChecked() {
  return components.value.some((i) => i.status !== 'running' && i.enabled)
}

function convertVisibility(shouldBeVisible: boolean) {
  if (shouldBeVisible) {
    return 'visible'
  } else {
    return 'hidden'
  }
}


</script>

<style>
ul {
  list-style-type: disc;
  padding-left: 20px;
}

.hover-box {
  position: absolute;
  background-color: rgba(90, 90, 90, 0.91);
  border: 1px solid #000000;
  padding: 10px;
  border-radius: 10px;
  z-index: 1;
}

table {
  border-collapse: separate;
  border-spacing: 10px;
}
</style>