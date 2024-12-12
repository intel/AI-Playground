<template>
  <div class="dialog-container z-10 text-white rounded-xl" style="background-color: rgba(0.3,0.3,0.3, 0.5)">
    <div class="dialog-container z-10 px-20 py-5">
      <h1 class="text-center py-1 px-4 rounded" style="font-size: 40px">
        {{ languages.BACKEND_MANAGE }}</h1>
      <!-- required components -->
      <div class="dialog-container z-10">
        <h1 class="text-left pt-10 rounded" style="font-size: 26px">
          {{ languages.BACKEND_REQUIRED_COMPONENTS }}</h1>
        <p class=" text-left pt-3 pb-7"> {{ languages.BACKEND_REQUIRED_COMPONENTS_MESSAGE }} </p>
        <table class="text-center w-full" style="table-layout: fixed;">
          <thead>
          <tr class="font-bold">
            <td style="text-align: left">{{ languages.BACKEND_SINGLE_COMPONENT }}</td>
            <td>{{ languages.BACKEND_STATUS }}</td>
            <td>{{ languages.BACKEND_INFORMATION }}</td>
            <td>{{ languages.BACKEND_TERMS }}</td>
            <td>{{ languages.BACKEND_ACTION }}</td>
          </tr>
          </thead>
          <tbody>
          <tr v-for="item in apiServiceInformationPlusTerms.filter((i) => i.isRequired)">
            <td style="text-align: left">{{ item.serviceName }}</td>
            <td :style="{ color: mapColorToStatus(item.status['status']) }">{{ item.status["status"] }}</td>
            <td>
              <a :href="getInfoURL(item.serviceName)" target="_blank">
              <span v-show="getInfoURL(item.serviceName) != ''" style="vertical-align: middle;"
                    class="svg-icon i-info w-7 h-7 px-6"></span>
              </a>
              <p v-show="getInfoURL(item.serviceName) == ''"> - </p>
            </td>
            <td>
              <button v-if="item.status['status'] !== 'running' && !item.isLoading" class="v-checkbox-control flex-none w-5 h-5"
                      :class="{ 'v-checkbox-checked': item.readTerms}" @click="item.readTerms = !item.readTerms"
                      :disabled="getInfoURL(item.serviceName) == ''">
              </button>
              <p v-else> - </p>
            </td>
            <td>
              <span v-if="item.isLoading" class="svg-icon i-loading flex-none w-5 h-5"></span>
              <button v-else-if="item.status['status'] === 'uninitialized'" @click="() => installBackend(item)"
                      :disabled="!item.readTerms"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_INSTALL }}
              </button>
              <button v-else-if="item.status['status'] === 'failed'" @click="() => repairBackend(item)"
                      :disabled="!item.readTerms"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_REPAIR }}
              </button>
              <button v-else-if="item.status['status'] === 'running'" @click="() => restartBackend(item)"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_RESTART }}
              </button>
              <button v-else-if="item.status['status'] === 'stopped'" @click="() => restartBackend(item)"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_START }}
              </button>
              <p v-else> - </p>
            </td>
          </tr>
          </tbody>
        </table>
      </div>

      <!-- optional components -->
      <div class="dialog-container z-10">
        <h1 class="text-left pt-10 rounded" style="font-size: 26px">{{
            languages.BACKEND_OPTIONAL_COMPONENTS
          }}</h1>
        <p class=" text-left pt-3 pb-7"> {{ languages.BACKEND_OPTIONAL_COMPONENTS_MESSAGE }} </p>
        <table class="text-center w-full" style="table-layout: fixed;">
          <thead>
          <tr class="font-bold">
            <td style="text-align: left">{{ languages.BACKEND_SINGLE_COMPONENT }}</td>
            <td>{{ languages.BACKEND_STATUS }}</td>
            <td>{{ languages.BACKEND_INFORMATION }}</td>
            <td>{{ languages.BACKEND_TERMS }}</td>
            <td>{{ languages.BACKEND_ACTION }}</td>
          </tr>
          </thead>
          <tbody>
          <tr v-for="item in apiServiceInformationPlusTerms.filter((i) => !i.isRequired)">
            <td style="text-align: left">{{ item.serviceName }}</td>
            <td :style="{ color: mapColorToStatus(item.status['status']) }">{{ item.status["status"] }}</td>
            <td>
              <a :href="getInfoURL(item.serviceName)" target="_blank">
              <span v-show="getInfoURL(item.serviceName) != ''" style="vertical-align: middle;"
                    class="svg-icon i-info w-7 h-7 px-6"></span>
              </a>
              <p v-show="getInfoURL(item.serviceName) == ''"> - </p>
            </td>
            <td>
              <button v-if="item.status['status'] !== 'running' && !item.isLoading" class="v-checkbox-control flex-none w-5 h-5"
                      :class="{ 'v-checkbox-checked': item.readTerms}" @click="item.readTerms = !item.readTerms"
                      :disabled="getInfoURL(item.serviceName) == ''">
              </button>
              <p v-else> - </p>
            </td>
            <td>
              <span v-if="item.isLoading" class="svg-icon i-loading flex-none w-5 h-5"></span>
              <button v-else-if="item.status['status'] === 'uninitialized'" @click="() => installBackend(item)"
                      :disabled="!item.readTerms"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_INSTALL }}
              </button>
              <button v-else-if="item.status['status'] === 'failed'" @click="() => repairBackend(item)"
                      :disabled="!item.readTerms"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_REPAIR }}
              </button>
              <button v-else-if="item.status['status'] === 'running'" @click="() => restartBackend(item)"
                      class="bg-color-active py-1 px-4 rounded">{{ languages.COM_RESTART }}
              </button>
              <button v-else-if="item.status['status'] === 'stopped'" @click="() => restartBackend(item)"
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
        <button :style="{visibility: convertVisibility(!isEverythingRunning())}" :disabled="!areBoxesChecked() || (apiServiceInformationPlusTerms.some((item) => item.isLoading))"
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
    </div>
  </div>

</template>

<script setup lang="ts">
import {Input} from '@/components/ui/input'

import {useI18N} from '@/assets/js/store/i18n';
import {useModels, userModels} from '@/assets/js/store/models';
import {useGlobalSetup} from '@/assets/js/store/globalSetup';
import {mapColorToStatus} from "@/lib/utils.ts";
import {toast} from "@/assets/js/toast.ts";

type ExtendedApiServiceInformation = ApiServiceInformation & { readTerms: boolean, isLoading: boolean }


const globalSetup = useGlobalSetup();


const apiServiceInformationPlusTerms = ref<ExtendedApiServiceInformation[]>([])
const somethingChanged = ref(false)


onBeforeMount(async () => {
  apiServiceInformationPlusTerms.value = (await window.electronAPI.getServiceRegistry()).map((item) => ({
    readTerms: areTermsInitiallyRead(item),
    isLoading: false, ...item
  }))
})

window.electronAPI.onServiceSetUpProgress(async (data) => {
  const name = data.serviceName
  const step = data.step
  const status = data.status

  console.log(`${name} in stage ${step} ${data.status}. Debugmessage: ${data.debugMessage}`)
  if (status === 'success') {
    const item = apiServiceInformationPlusTerms.value.filter((entry) => entry.serviceName === data.serviceName)[0]
    await restartBackend(item)
  } else if (status === 'failed') {
    toast.error("Setup failed")
    await reloadServiceRegistry()
    const item = apiServiceInformationPlusTerms.value.filter((entry) => entry.serviceName === data.serviceName)[0]
    item.isLoading = false
    // updateValue(item.serviceName, "isLoading", true)
  }
})

// function updateValue(serviceName: string, key: string, value: string | number) {
//   const updatedServiceRegistry = await window.electronAPI.getServiceRegistry()
//   apiServiceInformationPlusTerms.value = updatedServiceRegistry
//   apiServiceInformationPlusTerms.value.filter((entry) => entry.serviceName === serviceName)[0][key] = value
// }
//
// async function reloadServiceRegistryNew() { //ToDo Test implementation of this instead of reloadServiceRegistry + getComponent
//   // Update the serviceRegistry while maintaining constant references to its content
//   const updatedServiceRegistry = await window.electronAPI.getServiceRegistry()
//   for (const item of apiServiceInformationPlusTerms.value){
//     const updatedItem = updatedServiceRegistry.filter((entry) => entry.serviceName === item.serviceName)[0]
//     for (const prop in updatedItem) {
//       item[prop as keyof typeof item] = updatedItem[prop as keyof ApiServiceInformation]
//     }
//   }
// }

async function reloadServiceRegistry() {
  apiServiceInformationPlusTerms.value = (await window.electronAPI.getServiceRegistry()).map((item) =>
      ({
        readTerms: getComponent(apiServiceInformationPlusTerms.value, "serviceName", item).readTerms,
        isLoading: getComponent(apiServiceInformationPlusTerms.value, "serviceName", item).isLoading,
        ...item
      }))
}

function getComponent(data: ExtendedApiServiceInformation[], key: string, item: ApiServiceInformation | ExtendedApiServiceInformation): ExtendedApiServiceInformation {
  return data.filter((entry) => entry[key as keyof typeof entry] === item[key as keyof typeof item])[0]
}

async function installBackend(item: ExtendedApiServiceInformation) {
  somethingChanged.value = true;
  getComponent(apiServiceInformationPlusTerms.value, "serviceName", item).isLoading = true
  await window.electronAPI.sendSetUpSignal(item.serviceName)
}

async function repairBackend(item: ExtendedApiServiceInformation) {
  getComponent(apiServiceInformationPlusTerms.value, "serviceName", item).isLoading = true
  const stopStatus = await window.electronAPI.sendStopSignal(item.serviceName)
  if (stopStatus.status !== 'stopped') {
    toast.error("Service failed to stop")
    return
  }
  await reloadServiceRegistry()
  await installBackend(getComponent(apiServiceInformationPlusTerms.value, "serviceName", item));
}

async function restartBackend(item: ExtendedApiServiceInformation) {
  getComponent(apiServiceInformationPlusTerms.value, "serviceName", item).isLoading = true
  const stopStatus = await window.electronAPI.sendStopSignal(item.serviceName)
  if (stopStatus.status !== 'stopped') {
    toast.error("Service failed to stop")
    return
  }

  await reloadServiceRegistry()

  const startStatus = await window.electronAPI.sendStartSignal(item.serviceName)
  if (startStatus.status !== 'running') {
    toast.error("Service failed to restart")
    return
  }

  getComponent(apiServiceInformationPlusTerms.value, "serviceName", item).isLoading = false
  await reloadServiceRegistry()
}

function installAllSelected() {
  const checkedServices = apiServiceInformationPlusTerms.value.filter(item => item.readTerms && !(item.status['status'] === 'uninitialized' || item.status['status'] === 'failed'));
  checkedServices.forEach((item) => {
        getComponent(apiServiceInformationPlusTerms.value, "serviceName", item).isLoading = true
        if (item.status['status'] === 'failed') {
          repairBackend(item);
        } else {
          installBackend(item);
        }
      }
  )
}

function closeInstallations() {
  globalSetup.loadingState = "running"
}

function getInfoURL(serviceName: string) {
  switch (serviceName) {
    case "comfyui-backend":
      return "https://www.tngtech.com/"
    default:
      return ""
  }
}

function CanCloseInstallations() {
  return apiServiceInformationPlusTerms.value.every((i) => i.status['status'] === 'running' || !i.isRequired)
}

function isEverythingRunning() {
  return apiServiceInformationPlusTerms.value.every((i) => i.status['status'] === 'running')
}

function areBoxesChecked() {
  return apiServiceInformationPlusTerms.value.some((i) => i.status['status'] !== 'running' && i.readTerms)
}

function areTermsInitiallyRead(item: ApiServiceInformation | ExtendedApiServiceInformation) {
  return getInfoURL(item.serviceName) === "" || item.status['status'] === 'running'
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