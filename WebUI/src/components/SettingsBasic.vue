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
          class="h-[30px] leading-[30px] rounded-[15px] bg-card border-border text-foreground px-[3px]"
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

    <div class="pt-4">
      <p>{{ languages.SETTINGS_AUDIO }}</p>
      <div class="pl-2 pt-4">
        <div class="grid grid-cols-[120px_1fr] items-center gap-4 mb-4">
          <Label class="whitespace-nowrap">Speech To Text</Label>
          <Checkbox v-if="!backendStarting"
            id="speech-to-text"
            :modelValue="speechToText.enabled"
            @update:modelValue="handleSpeechToTextToggle"
          />
          <Spinner v-else class="justify-self-start" />
        </div>
        <MicrophoneSettings v-if="speechToText.enabled" />
        <div v-if="speechToText.enabled && sttDevices.length > 0" class="grid grid-cols-[120px_1fr] items-center gap-4 mt-4">
          <Label class="whitespace-nowrap">Device</Label>
          <drop-down-new
            title="STT Device"
            @change="selectSttDevice"
            :value="selectedSttDevice?.id"
            :items="sttDeviceItems"
          />
        </div>
      </div>
    </div>

    <div class="flex flex-col pt-5">
      <button
        @click="globalSetup.loadingState = 'manageInstallations'"
        class="bg-primary hover:bg-primary/80 px-3 py-1.5 rounded-lg text-sm"
      >
        {{ languages.SETTINGS_MODEL_MANAGE_BACKEND }}
      </button>
    </div>
  </div>
  <div class="flex flex-col gap-3 pt-6 border-t border-border">
    <div class="flex justify-between items-center">
      <p>
        {{
          i18nState.SETTINGS_PRESETS_MANAGEMENT ||
          languages.SETTINGS_PRESETS_MANAGEMENT ||
          'Presets Management'
        }}
      </p>
      <div class="flex gap-2 items-center">
        <div :data-tooltip="i18nState.PRESET_RELOAD_INFO">
          <button
            class="svg-icon i-refresh w-5 h-5 text-primary"
            @click="presetsStore.loadPresetsFromFiles"
          ></button>
        </div>
        <div :data-tooltip="i18nState.PRESET_DOWNLOAD_INFO">
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
import { computed, onMounted, watch } from 'vue'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useModels } from '@/assets/js/store/models'
import { useTheme } from '@/assets/js/store/theme'
import { mapServiceNameToDisplayName, mapStatusToColor, mapToDisplayStatus } from '@/lib/utils.ts'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { usePresets } from '@/assets/js/store/presets'
import { useSpeechToText } from '@/assets/js/store/speechToText'
import * as toast from '@/assets/js/toast'
import LanguageSelector from '@/components/LanguageSelector.vue'
import ThemeSelector from '@/components/ThemeSelector.vue'
import MicrophoneSettings from '@/components/MicrophoneSettings.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useI18N } from '@/assets/js/store/i18n'
import { Spinner } from './ui/spinner'

const globalSetup = useGlobalSetup()
const backendServices = useBackendServices()
const models = useModels()
const theme = useTheme()
const presetsStore = usePresets()
const i18nState = useI18N().state
const speechToText = useSpeechToText()
const backendStarting = ref(false)

const displayComponents = computed(() => {
  return backendServices.info.map((item) => ({
    serviceName: item.serviceName,
    status: item.status,
  }))
})

// STT device selection
const sttDevices = computed(
  () =>
    backendServices.info.find((bs) => bs.serviceName === 'openvino-backend')?.sttDevices ?? [],
)
const selectedSttDevice = computed(
  () => sttDevices.value.find((d: InferenceDevice) => d.selected) ?? sttDevices.value[0],
)
const sttDeviceItems = computed(() =>
  sttDevices.value.map((d: InferenceDevice) => ({
    label: `${d.id}: ${d.name}`,
    value: d.id,
    active: true,
  })),
)

async function selectSttDevice(deviceId: string) {
  await backendServices.selectSttDevice('openvino-backend', deviceId)
}

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

// Watch for changes to enabled state and ensure server is running
watch(
  () => speechToText.enabled,
  async (enabled) => {
    if (enabled) {
      await speechToText.ensureTranscriptionServerRunning()
    }
  },
  { immediate: false },
)

// Initialize transcription server on mount if enabled
onMounted(async () => {
  await speechToText.initialize()
})

// Handle toggle using store method
async function handleSpeechToTextToggle(enabled: boolean | 'indeterminate') {
  backendStarting.value = true
  try {
    await speechToText.toggle(enabled === true)
  } catch (_error) {
    toast.error(`Failed to ${enabled ? 'enable' : 'disable'} Speech To Text`)
  } finally {
    backendStarting.value = false
  }
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
