<template>
  <div class="dialog-container z-10">
    <h1 class="text-center py-1 px-4 rounded text-white" style="font-size: 40px">
      {{ languages.BACKEND_MANAGE }}</h1>
    <!-- required components -->
    <div class="dialog-container z-10">
      <h1 class="text-left pt-10 rounded text-white" style="font-size: 26px">
        {{ languages.BACKEND_REQUIRED_COMPONENTS }}</h1>
      <p class=" text-left pt-3 pb-7 text-white"> {{ languages.BACKEND_REQUIRED_COMPONENTS_MESSAGE }} </p>
      <table class="text-left w-full">
        <thead>
        <tr class="text-white font-bold">
          <td>{{ languages.BACKEND_SINGLE_COMPONENT }}</td>
          <td>{{ languages.BACKEND_STATUS }}</td>
          <td>{{ languages.BACKEND_INFORMATION }}</td>
          <td>{{ languages.BACKEND_TERMS }}</td>
          <td>{{ languages.BACKEND_ACTION }}</td>
        </tr>
        </thead>
        <tbody>
        <tr v-for="item in apiServiceInformationPlusTerms.filter((i) => i.isRequired)" class="text-white">
          <td>{{ item.serviceName }}</td>
          <td :style="{ color: mapColorToStatus(item.status['status']) }">{{ item.status["status"] }}</td>
          <td>
            <a :href="getInfoURL(item.serviceName)" target="_blank">
              <span v-show="getInfoURL(item.serviceName) != ''" style="vertical-align: middle;"
                    class="svg-icon i-info w-7 h-7 px-6"></span>
            </a>
            <p v-show="getInfoURL(item.serviceName) == ''"> - </p>
          </td>
          <td>
            <button v-if="item.status['status'] !== 'running'" class="v-checkbox-control flex-none w-5 h-5"
                    :class="{ 'v-checkbox-checked': item.readTerms }" @click="item.readTerms = !item.readTerms" :disabled="getInfoURL(item.serviceName) == ''">
            </button>
            <p v-else> - </p>
          </td>
          <td>
            <button v-if="item.status['status'] === 'uninitialized'" @click="installBackend" :disabled="!item.readTerms"
                    class="bg-color-active py-1 px-4 rounded">{{ languages.COM_INSTALL }}
            </button>
            <button v-else-if="item.status['status'] === 'failed'" @click="repairBackend" :disabled="!item.readTerms"
                    class="bg-color-active py-1 px-4 rounded">{{ languages.COM_REPAIR }}
            </button>
            <p v-else> - </p>
          </td>
        </tr>
        </tbody>
      </table>
    </div>

    <!-- optional components -->
    <div class="dialog-container z-10">
      <h1 class="text-left pt-10 rounded text-white" style="font-size: 26px">{{
          languages.BACKEND_OPTIONAL_COMPONENTS
        }}</h1>
      <p class=" text-left pt-3 pb-7 text-white"> {{ languages.BACKEND_OPTIONAL_COMPONENTS_MESSAGE }} </p>
      <table class="text-left w-full">
        <thead>
        <tr class="text-white font-bold">
          <td>{{ languages.BACKEND_SINGLE_COMPONENT }}</td>
          <td>{{ languages.BACKEND_STATUS }}</td>
          <td>{{ languages.BACKEND_INFORMATION }}</td>
          <td>{{ languages.BACKEND_TERMS }}</td>
          <td>{{ languages.BACKEND_ACTION }}</td>
        </tr>
        </thead>
        <tbody>
        <tr v-for="item in apiServiceInformationPlusTerms.filter((i) => !i.isRequired)" class="text-white">
          <td>{{ item.serviceName }}</td>
          <td :style="{ color: mapColorToStatus(item.status['status']) }">{{ item.status["status"] }}</td>
          <td>
            <a :href="getInfoURL(item.serviceName)" target="_blank">
              <span v-show="getInfoURL(item.serviceName) != ''" style="vertical-align: middle;"
                    class="svg-icon i-info w-7 h-7 px-6"></span>
            </a>
            <p v-show="getInfoURL(item.serviceName) == ''"> - </p>
          </td>
          <td>
            <button v-if="item.status['status'] !== 'running'" class="v-checkbox-control flex-none w-5 h-5"
                    :class="{ 'v-checkbox-checked': item.readTerms }" @click="item.readTerms = !item.readTerms" :disabled="getInfoURL(item.serviceName) == ''">
            </button>
            <p v-else> - </p>
          </td>
          <td>
            <button v-if="item.status['status'] === 'uninitialized'" @click="installBackend" :disabled="!item.readTerms"
                    class="bg-color-active py-1 px-4 rounded">{{ languages.COM_INSTALL }}
            </button>
            <button v-else-if="item.status['status'] === 'failed'" @click="repairBackend" :disabled="!item.readTerms"
                    class="bg-color-active py-1 px-4 rounded">{{ languages.COM_REPAIR }}
            </button>
            <p v-else> - </p>
          </td>
        </tr>
        </tbody>
      </table>
    </div>

    <!-- close/install all//continue -->
    <div class="dialog-container flex justify-between z-10 pt-10" style="display: flex">
      <button :style="{visibility: convertVisibility(!somethingChanged)}" :disabled="!CanCloseInstallations()" @click="closeInstallations"
              class="text-white flex bg-color-active py-1 px-4 rounded">{{
          languages.COM_CLOSE
        }}
      </button>
      <button :style="{visibility: convertVisibility(!isEverythingRunning())}" :disabled="!areBoxesChecked()" @click="installAllSelected"
              class="text-white flex bg-color-active py-1 px-4 rounded">{{
          languages.COM_INSTALL_ALL
        }}
      </button>
      <button :style="{visibility: convertVisibility(somethingChanged)}" :disabled="!CanCloseInstallations()" @click="closeInstallations"
              class="text-white flex bg-color-active py-1 px-4 rounded">{{
          languages.COM_CONTINUE
        }}
      </button>
    </div>

    <!-- terms and conditions -->
    <div class="dialog-container text-white z-10 pt-10" style="display: flex">
      <p>{{ languages.BACKEND_TERMS_AND_CONDITIONS }}</p>
    </div>
  </div>

</template>

<script setup lang="ts">
import {Input} from '@/components/ui/input'
import {useGlobalSetup} from '@/assets/js/store/globalSetup';
import {useI18N} from '@/assets/js/store/i18n';
import {useModels, userModels} from '@/assets/js/store/models';


const apiServiceInformationPlusTerms = ref<ApiServiceInformation[] & { readTerms: boolean }>([])
const somethingChanged = ref(false)


onBeforeMount(async () => {
  apiServiceInformationPlusTerms.value = (await window.electronAPI.getServiceRegistry()).map((item) => ({readTerms: areTermsInitiallyRead(item), ...item}))
})


function installBackend() {
  somethingChanged.value = true;
}

function repairBackend() {
  somethingChanged.value = true;
}

function installAllSelected() {

}

function closeInstallations() {
}


function mapColorToStatus(status: string) {
  switch (status) {
    case "running":
      return 'green'
    case "failed":
      return 'red'
    case "uninitialized":
      return 'gray'
    default:
      return 'blue'
  }
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
  return apiServiceInformationPlusTerms.value.every((i) => i.isRequired && i.status['status'] === 'running')
}

function isEverythingRunning() {
  return apiServiceInformationPlusTerms.value.every((i) => i.status['status'] === 'running')
}

function areBoxesChecked() {
  return apiServiceInformationPlusTerms.value.some((i) => i.status['status'] !== 'running' && i.readTerms)
}

function areTermsInitiallyRead(item : object) {
  return  getInfoURL(item.serviceName) === "" || item.status['status'] === 'running'
}

function convertVisibility(shouldBeVisible : boolean) {
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