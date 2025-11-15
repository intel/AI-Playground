<template>
  <div class="border-b border-border flex flex-col gap-5 py-4">
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
      <button @click="globalSetup.loadingState = 'manageInstallations'" class="bg-primary hover:bg-primary/80 px-3 py-1.5 rounded-lg text-sm">
        {{ languages.SETTINGS_MODEL_MANAGE_BACKEND }}
      </button>
    </div>
  </div>
  <div class="flex flex-col gap-3 pt-6 border-t border-border">
    <div class="flex justify-between items-center">
      <p>{{ i18nState.SETTINGS_PRESETS_MANAGEMENT || languages.SETTINGS_PRESETS_MANAGEMENT || 'Presets Management' }}</p>
      <div class="flex gap-2 items-center">
        <div :data-tooltip="i18nState.PRESET_RELOAD_INFO || i18nState.WORKFLOW_RELOAD_INFO">
          <button
            class="svg-icon i-refresh w-5 h-5 text-primary"
            @click="presetsStore.loadPresetsFromFiles"
          ></button>
        </div>
        <div :data-tooltip="i18nState.PRESET_DOWNLOAD_INFO || i18nState.WORKFLOW_DOWNLOAD_INFO">
          <button
            class="svg-icon i-download-cloud w-5 h-5 text-primary"
            @click="loadPresetsFromIntel"
          ></button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useModels } from '@/assets/js/store/models'
import { useTheme } from '@/assets/js/store/theme'
import { mapServiceNameToDisplayName, mapStatusToColor, mapToDisplayStatus } from '@/lib/utils.ts'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { usePresets } from '@/assets/js/store/presets'
import { useI18N } from '@/assets/js/store/i18n.ts'
import * as toast from '@/assets/js/toast'
import LanguageSelector from '@/components/LanguageSelector.vue'
import ThemeSelector from '@/components/ThemeSelector.vue'

const globalSetup = useGlobalSetup()
const backendServices = useBackendServices()
const models = useModels()
const theme = useTheme()
const presetsStore = usePresets()
const i18nState = useI18N().state

const displayComponents = computed(() => {
  return backendServices.info.map((item) => ({
    serviceName: item.serviceName,
    status: item.status,
  }))
})

async function loadPresetsFromIntel() {
  const syncStatus = await presetsStore.loadPresetsFromIntel()
  if (syncStatus.result === 'success') {
    toast.success(`Backed up presets at ${syncStatus.backupDir}`)
  } else if (syncStatus.result === 'noUpdate') {
    toast.warning('No updated presets available')
  } else {
    toast.error('Synchronisation failed')
  }
}

function openDebug() {
  window.electronAPI.openDevTools()
}
</script>

<style>
[data-tooltip]:hover::after {
  display: block;
  position: absolute;
  right: 10px;
  content: attr(data-tooltip);
  border: 1px solid hsl(var(--border));
  background: hsl(var(--muted));
  color: hsl(var(--foreground));
  border-radius: 0.5rem;
  padding: 0.7em;
  z-index: 10;
}
</style>
