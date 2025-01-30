<template>
  <div class="border-b border-color-spilter flex flex-col gap-5 py-4">
    <h2 class="text-center font-bold">{{ languages.SETTINGS_BASIC_GENERAL }}</h2>
    <div class="flex flex-col gap-2">
      <p>{{ languages.SETTINGS_BASIC_LANGUAGE }}</p>
      <LanguageSelector></LanguageSelector>
    </div>
    <div v-if="theme.availableThemes.length > 1" class="flex flex-col gap-2">
      <p>{{ languages.SETTINGS_THEME }}</p>
      <div class="grid gap-2" :class="{ [`grid-cols-${theme.availableThemes.length}`]: true }">
        <radio-block
          v-for="themeName in theme.availableThemes"
          :key="themeName"
          :checked="theme.active === themeName"
          :text="themeToDisplayName(themeName)"
          @click="() => (theme.selected = themeName)"
        ></radio-block>
      </div>
    </div>
  </div>
  <div class="border-b border-color-spilter flex flex-col gap-5 py-4">
    <h2 class="text-center font-bold">{{ languages.SETTINGS_BASIC_DEVICES }}</h2>
    <p>{{ languages.SETTINGS_INFERENCE_DEVICE }}</p>
    <div class="flex items-center gap-2 flex-wrap">
      <drop-selector :array="globalSetup.graphicsList" @change="changeGraphics">
        <template #selected>
          <div class="flex gap-2 items-center">
            <span class="rounded-full bg-green-500 w-2 h-2"></span>
            <span>{{ graphicsName }}</span>
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
  <div class="border-b border-color-spilter flex flex-col gap-5 py-4">
    <h2 class="text-center font-bold">{{ languages.SETTINGS_BASIC_BACKEND }}</h2>
    <div class="flex flex-col gap-2">
      <p>{{ languages.SETTINGS_LLM_BACKEND }}</p>
      <div class="flex items-center gap-2">
        <drop-selector
          :array="[...backendTypes]"
          @change="(item) => (textInference.backend = item)"
        >
          <template #selected>
            <div class="flex gap-2 items-center">
              <span
                class="rounded-full w-2 h-2"
                :class="{
                  'bg-green-500': isRunning(textInference.backend),
                  'bg-gray-500': !isRunning(textInference.backend),
                }"
              ></span>
              <span>{{ textInferenceBackendDisplayName[textInference.backend] }}</span>
              <!--       Flag LlamaCpp as experimental       -->
              <span
                v-if="textInference.backend == 'LLAMA.CPP'"
                class="rounded-lg h-4 px-1 text-xs"
                :style="{ 'background-color': '#cc00ff88' }"
              >
                Experimental</span
              >
            </div>
          </template>
          <template #list="slotItem">
            <div class="flex gap-2 items-center">
              <span
                class="rounded-full w-2 h-2"
                :class="{
                  'bg-green-500': isRunning(slotItem.item),
                  'bg-gray-500': !isRunning(slotItem.item),
                }"
              ></span>
              <span>{{
                textInferenceBackendDisplayName[slotItem.item as (typeof backendTypes)[number]]
              }}</span>
              <span
                v-if="slotItem.item == 'LLAMA.CPP'"
                class="rounded-lg h-4 px-1 text-xs"
                :style="{ 'background-color': '#cc00ff88' }"
              >
                Experimental</span
              >
            </div>
          </template>
        </drop-selector>
      </div>
    </div>
    <div class="flex flex-col gap-3">
      <p>{{ languages.SETTINGS_BACKEND_STATUS }}</p>
      <table class="text-center w-full mx-2 table-fixed">
        <tbody>
          <tr v-for="item in displayComponents" :key="item.serviceName">
            <td style="text-align: left">{{ mapServiceNameToDisplayName(item.serviceName) }}</td>
            <td :style="{ color: mapStatusToColor(item.status) }">
              {{ mapToDisplayStatus(item.status) }}
            </td>
          </tr>
        </tbody>
      </table>
      <div class="flex flex-col pt-5">
        <button @click="globalSetup.loadingState = 'manageInstallations'" class="confirm-btn">
          {{ languages.SETTINGS_MODEL_MANAGE_BACKEND }}
        </button>
      </div>
    </div>
  </div>
  <div class="text-right my-5">
    <button @click="openDebug" class="v-radio-block">{{ languages.COM_DEBUG }}</button>
  </div>
</template>
<script setup lang="ts">
import DropSelector from '../components/DropSelector.vue'
import RadioBlock from '../components/RadioBlock.vue'

import { useGlobalSetup } from '@/assets/js/store/globalSetup'

import { useTheme } from '@/assets/js/store/theme'
import { useTextInference, backendTypes, Backend } from '@/assets/js/store/textInference'
import { mapServiceNameToDisplayName, mapStatusToColor, mapToDisplayStatus } from '@/lib/utils.ts'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import LanguageSelector from '@/components/LanguageSelector.vue'

const globalSetup = useGlobalSetup()
const textInference = useTextInference()
const backendServices = useBackendServices()
const theme = useTheme()

const textInferenceBackendDisplayName: Record<(typeof backendTypes)[number], string> = {
  'IPEX-LLM': 'IPEX-LLM',
  'LLAMA.CPP': 'Llama.cpp - GGUF',
}

const themeToDisplayName = (theme: Theme) => {
  switch (theme) {
    case 'dark':
      return 'Default'
    case 'lnl':
      return 'Intel® Core™ Ultra'
    case 'bmg':
      return 'Intel® Arc™'
    default:
      return theme
  }
}

const displayComponents = computed(() => {
  return backendServices.info.map((item) => ({
    serviceName: item.serviceName,
    status: item.status,
  }))
})

const modelSettings = reactive<KVObject>(Object.assign({}, toRaw(globalSetup.modelSettings)))

const graphicsName = computed(() => {
  return (
    globalSetup.graphicsList.find((item) => (modelSettings.graphics as number) == item.index)
      ?.name || ''
  )
})

function openDebug() {
  window.electronAPI.openDevTools()
}

function changeGraphics(value: GraphicsItem, _index: number) {
  globalSetup.applyModelSettings({ graphics: value.index })
}

function mapBackendNames(name: Backend): BackendServiceName | undefined {
  if (name === 'IPEX-LLM') {
    return 'ai-backend' as BackendServiceName
  } else if (name === 'LLAMA.CPP') {
    return 'llamacpp-backend' as BackendServiceName
  } else {
    return undefined
  }
}

function isRunning(name: Backend) {
  const backendName: BackendServiceName | undefined = mapBackendNames(name)
  return backendServices.info.find((item) => item.serviceName === backendName)?.status === 'running'
}
</script>
