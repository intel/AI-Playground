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
    <div class="flex flex-col gap-3"></div>
    <div class="flex flex-col gap-3">
      <p>{{ languages.SETTINGS_MODEL_HUGGINGFACE_SETTINGS }}</p>
      <h4 class="text-sm font-medium">{{ languages.SETTINGS_MODEL_HUGGINGFACE_API_TOKEN }}</h4>
      <div class="flex flex-col items-start gap-1">
        <Input
          type="password"
          v-model="models.hfToken"
          class="h-[30px] leading-[30px] rounded-md bg-card border-border text-foreground px-[3px]"
          :class="{ 'border-red-500': models.hfToken && !models.hfTokenIsValid }"
        />
        <div
          class="text-xs text-red-500 select-none"
          :class="{ 'opacity-0': !(models.hfToken && !models.hfTokenIsValid) }"
        >
          {{ languages.SETTINGS_MODEL_HUGGINGFACE_INVALID_TOKEN_TEXT }}
        </div>
      </div>
      <h4 class="text-sm font-medium">{{ languages.SETTINGS_MODEL_HUGGINGFACE_MIRROR_URL }}</h4>
      <div class="flex flex-col items-start gap-2">
        <Input
          v-model="mirrorUrl"
          placeholder="https://huggingface.co"
          class="h-[30px] leading-[30px] rounded-md bg-card border-border text-foreground px-[3px]"
          :class="{ 'border-red-500': mirrorUrl && !isValidUrl(mirrorUrl) }"
        />
        <div class="flex gap-2 items-center">
          <Button
            variant="outline"
            size="sm"
            :disabled="!mirrorUrl || !isValidUrl(mirrorUrl)"
            @click="verifyMirror"
          >
            {{ languages.SETTINGS_MODEL_HUGGINGFACE_VERIFY }}
          </Button>
          <Button
            variant="default"
            size="sm"
            :disabled="!mirrorUrl || !isValidUrl(mirrorUrl)"
            @click="applyHfSettings"
          >
            {{ languages.SETTINGS_MODEL_HUGGINGFACE_APPLY }}
          </Button>
        </div>
        <div
          v-if="verificationMessage"
          class="text-xs"
          :class="verificationSuccess ? 'text-green-500' : 'text-yellow-600'"
        >
          {{ verificationMessage }}
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
        <div class="flex justify-between pr-4 items-center gap-4 mb-4">
          <Label class="whitespace-nowrap">Speech To Text</Label>
          <Checkbox
            v-if="!backendStarting"
            id="speech-to-text"
            :modelValue="speechToText.enabled"
            @update:modelValue="handleSpeechToTextToggle"
          />
          <Spinner v-else class="justify-self-start" />
        </div>
        <MicrophoneSettings v-if="speechToText.enabled" />
        <div
          v-if="speechToText.enabled && sttDevices.length > 0"
          class="grid grid-cols-[120px_1fr] items-center gap-4 mt-4"
        >
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
    <p>{{ languages.SETTINGS_DEVELOPER }}</p>
    <div class="pl-2 pt-2">
      <div class="flex justify-between pr-4 items-center gap-4 mb-4">
        <Label class="whitespace-nowrap">{{
          languages.SETTINGS_DEVELOPER_OPEN_DEV_CONSOLE_ON_STARTUP
        }}</Label>
        <Checkbox id="open-dev-console" v-model="developerSettings.openDevConsoleOnStartup" />
      </div>
      <div class="flex justify-between pr-4 items-center gap-4 mb-4">
        <div class="flex items-center gap-2">
          <Label class="whitespace-nowrap">{{
            languages.SETTINGS_DEVELOPER_KEEP_MODELS_LOADED || 'Keep Models Loaded'
          }}</Label>
          <TooltipProvider :delay-duration="200">
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="bottom" class="max-w-[300px]">
                {{
                  languages.SETTINGS_DEVELOPER_KEEP_MODELS_LOADED_INFO
                    || 'When enabled, chat and image generation models stay loaded in memory simultaneously. Requires more VRAM but avoids reloading models when switching between chat and image generation.'
                }}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <Checkbox
          id="keep-models-loaded"
          v-model="developerSettings.keepModelsLoaded"
        />
      </div>
    </div>
    <div class="flex justify-between items-center">
      <p>
        {{
          i18nState.SETTINGS_PRESETS_MANAGEMENT ||
          languages.SETTINGS_PRESETS_MANAGEMENT ||
          'Presets Management'
        }}
      </p>
      <div class="flex pr-4 gap-2 items-center">
        <div :data-tooltip="i18nState.PRESET_RELOAD_INFO">
          <button
            class="svg-icon i-refresh w-5 h-5"
            @click="presetsStore.loadPresetsFromFiles"
          ></button>
        </div>
        <div :data-tooltip="i18nState.PRESET_DOWNLOAD_INFO">
          <button class="svg-icon i-download-cloud w-5 h-5" @click="loadPresetsFromIntel"></button>
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
</template>

<script setup lang="ts">
import { computed, watch, ref } from 'vue'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useModels } from '@/assets/js/store/models'
import { useTheme } from '@/assets/js/store/theme'
import { mapServiceNameToDisplayName, mapStatusToColor, mapToDisplayStatus } from '@/lib/utils.ts'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { usePresets } from '@/assets/js/store/presets'
import { useSpeechToText } from '@/assets/js/store/speechToText'
import { useDeveloperSettings } from '@/assets/js/store/developerSettings'
import { useDialogStore } from '@/assets/js/store/dialogs'
import * as toast from '@/assets/js/toast'
import LanguageSelector from '@/components/LanguageSelector.vue'
import ThemeSelector from '@/components/ThemeSelector.vue'
import MicrophoneSettings from '@/components/MicrophoneSettings.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18N } from '@/assets/js/store/i18n'
import { Spinner } from './ui/spinner'
import { Button } from '@/components/ui/button'

const globalSetup = useGlobalSetup()
const backendServices = useBackendServices()
const models = useModels()
const theme = useTheme()
const presetsStore = usePresets()
const i18nState = useI18N().state
const languages = i18nState
const speechToText = useSpeechToText()
const developerSettings = useDeveloperSettings()
const dialogStore = useDialogStore()
const backendStarting = ref(false)

const mirrorUrl = ref(models.hfEndpoint)
const verificationMessage = ref('')
const verificationSuccess = ref(false)

function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

async function verifyMirror() {
  if (!mirrorUrl.value || !isValidUrl(mirrorUrl.value)) {
    return
  }

  verificationMessage.value = 'Verifying...'
  verificationSuccess.value = false

  try {
    const isValid = await models.verifyHfEndpoint(mirrorUrl.value)
    console.log('isValid', isValid)
    if (isValid.success) {
      verificationMessage.value = i18nState.SETTINGS_MODEL_HUGGINGFACE_VERIFICATION_SUCCESS
      verificationSuccess.value = true
    } else {
      verificationMessage.value = i18nState.SETTINGS_MODEL_HUGGINGFACE_VERIFICATION_FAILED.replace(
        '{error}',
        'Verification failed',
      )
      verificationSuccess.value = false
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    verificationMessage.value = i18nState.SETTINGS_MODEL_HUGGINGFACE_VERIFICATION_FAILED.replace(
      '{error}',
      errorMessage,
    )
    verificationSuccess.value = false
  }
}

async function applyHfSettings() {
  if (!mirrorUrl.value || !isValidUrl(mirrorUrl.value)) {
    return
  }

  let userConfirmed = false
  dialogStore.showWarningDialog(i18nState.SETTINGS_MODEL_HUGGINGFACE_APPLY_CONFIRM, () => {
    userConfirmed = true
  })

  return new Promise<void>((resolve) => {
    const checkDialog = setInterval(() => {
      if (!dialogStore.warningDialogVisible) {
        clearInterval(checkDialog)
        if (userConfirmed) {
          executeRestartBackends().then(resolve)
        } else {
          resolve()
        }
      }
    }, 100)
  })
}

async function executeRestartBackends() {
  try {
    await models.updateHfEndpoint(mirrorUrl.value)

    const servicesToRestart = ['ai-backend', 'comfyui-backend'] as const

    // Stop all running services, using the return value (not reactive state) to track success
    const stopResults = await Promise.all(
      servicesToRestart.map(async (serviceName) => {
        const serviceInfo = backendServices.info.find((s) => s.serviceName === serviceName)
        if (serviceInfo?.status === 'running') {
          const status = await backendServices.stopService(serviceName)
          return { serviceName, status }
        }
        return { serviceName, status: 'stopped' as BackendStatus }
      }),
    )

    const allStopped = stopResults.every((r) => r.status === 'stopped')
    if (!allStopped) {
      toast.error('Failed to stop one or more backends')
      return
    }

    // Start all services, using the return value to track success
    const startResults = await Promise.all(
      servicesToRestart.map(async (serviceName) => {
        const status = await backendServices.startService(serviceName)
        return { serviceName, status }
      }),
    )

    const allRunning = startResults.every((r) => r.status === 'running')
    if (allRunning) {
      toast.success(i18nState.SETTINGS_MODEL_HUGGINGFACE_APPLY_SUCCESS)
    } else {
      toast.error('Failed to restart one or more backends')
    }
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to apply HuggingFace settings'
    toast.error(errorMessage)
  }
}

const displayComponents = computed(() => {
  return backendServices.info.map((item) => ({
    serviceName: item.serviceName,
    status: item.status,
  }))
})

// STT device selection
const sttDevices = computed(
  () => backendServices.info.find((bs) => bs.serviceName === 'openvino-backend')?.sttDevices ?? [],
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
