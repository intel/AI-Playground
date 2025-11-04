<template>
  <div class="border-b border-color-spilter flex flex-col gap-5 py-4">
    <div class="flex flex-col gap-2">
      <p>{{ languages.SETTINGS_BASIC_LANGUAGE }}</p>
      <LanguageSelector></LanguageSelector>
    </div>
    <div v-if="theme.availableThemes.length > 1" class="flex flex-col gap-2">
      <p>{{ languages.SETTINGS_THEME }}</p>
      <ThemeSelector />
    </div>
    <div class="flex flex-col gap-3">
      <p>{{ languages.SETTINGS_MODEL_HUGGINGFACE_API_TOKEN }}</p>
      <div class="flex flex-col items-start gap-1">
        <Input
          type="password"
          v-model="models.hfToken"
          class="v-drop-select"
          :class="{ 'border-red-500': models.hfToken && !models.hfTokenIsValid }"
        />
        <div
          class="text-xs text-red-500 select-none"
          :class="{ 'opacity-0': !(models.hfToken && !models.hfTokenIsValid) }"
        >
          {{ languages.SETTINGS_MODEL_HUGGINGFACE_INVALID_TOKEN_TEXT }}
        </div>
      </div>
    </div>
  </div>
  <div class="flex flex-col gap-3 pt-6">
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
  <!--  todo: delete this div after migrating fully to new UI-->
  <div class="text-right my-5">
    <button @click="openDebug" class="v-radio-block">{{ languages.COM_DEBUG }}</button>
  </div>
</template>

<script setup lang="ts">
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useModels } from '@/assets/js/store/models'
import { useTheme } from '@/assets/js/store/theme'
import { mapServiceNameToDisplayName, mapStatusToColor, mapToDisplayStatus } from '@/lib/utils.ts'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import LanguageSelector from '@/components/LanguageSelector.vue'
import ThemeSelector from '@/components/ThemeSelector.vue'

const globalSetup = useGlobalSetup()
const backendServices = useBackendServices()
const models = useModels()
const theme = useTheme()

// todo: why is this not used
const _themeToDisplayName = (theme: Theme) => {
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

function openDebug() {
  window.electronAPI.openDevTools()
}
</script>
