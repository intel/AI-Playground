<template>
  <div class="border-b border-border flex flex-col gap-5 py-4">
    <DemoModeBlocker>
      <div class="flex flex-col gap-2">
        <SettingsHeading>{{ languages.SETTINGS_BASIC_LANGUAGE }}</SettingsHeading>
        <LanguageSelector></LanguageSelector>
      </div>
    </DemoModeBlocker>

    <div class="flex flex-col gap-2">
      <SettingsHeading>{{ languages.SETTINGS_THEME }}</SettingsHeading>
      <ThemeSelector />
    </div>

    <DemoModeBlocker>
      <div class="flex flex-col gap-3">
        <SettingsHeading>{{ languages.SETTINGS_MODEL_HUGGINGFACE_SETTINGS }}</SettingsHeading>
        <SettingsHeading sub>{{ languages.SETTINGS_MODEL_HUGGINGFACE_API_TOKEN }}</SettingsHeading>
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
        <SettingsHeading sub>{{ languages.SETTINGS_MODEL_HUGGINGFACE_MIRROR_URL }}</SettingsHeading>
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
    </DemoModeBlocker>
  </div>
  <DemoModeBlocker>
    <div class="flex flex-col gap-3 pt-6">
      <SettingsHeading>{{ languages.SETTINGS_BACKEND_STATUS }}</SettingsHeading>
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
    </div>
  </DemoModeBlocker>

  <DemoModeBlocker>
    <div class="flex flex-col gap-3 pt-4">
      <p>External speech endpoints</p>
      <div class="pl-2 pt-2 flex flex-col gap-4">
        <!-- Text to Speech fallback: enabling it adds an "External endpoint" engine
             option to the Text to Speech preset (works in every product mode). -->
        <div>
          <div class="flex justify-between pr-4 items-center gap-4">
            <div class="flex items-center gap-2">
              <Label class="whitespace-nowrap">Text to Speech endpoint</Label>
              <TooltipProvider :delay-duration="200">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" class="max-w-[320px]">
                    An OpenAI-compatible <code>/v1/audio/speech</code> server (base URL like
                    <code>http://127.0.0.1:8080/v1</code>). When enabled, it appears as the
                    "External endpoint" engine in the Text to Speech preset.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Checkbox id="tts-fallback-enabled" v-model="textToSpeech.fallback.enabled" />
          </div>
        </div>

        <!-- Speech to Text fallback: enabling it adds an "External endpoint" engine to
             the Speech to Text preset AND makes that preset available in NVIDIA mode
             (Whisper/OpenVINO is otherwise unavailable there). -->
        <div class="border-t border-white/10 pt-4">
          <div class="flex justify-between pr-4 items-center gap-4">
            <div class="flex items-center gap-2">
              <Label class="whitespace-nowrap">Speech to Text endpoint</Label>
              <TooltipProvider :delay-duration="200">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" class="max-w-[320px]">
                    An OpenAI-compatible transcription server — e.g. a local whisper.cpp
                    <code>whisper-server</code> with
                    <code>--inference-path "/v1/audio/transcriptions"</code> (base URL like
                    <code>http://127.0.0.1:2022/v1</code>). Enabling it also makes the Speech to
                    Text preset available in NVIDIA mode.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Checkbox id="stt-fallback-enabled" v-model="speechToText.fallback.enabled" />
          </div>
        </div>
      </div>
    </div>
  </DemoModeBlocker>

  <DemoModeBlocker>
    <div class="flex flex-col gap-3 pt-4">
      <SettingsHeading>{{ languages.SETTINGS_DEVELOPER }}</SettingsHeading>
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
                    languages.SETTINGS_DEVELOPER_KEEP_MODELS_LOADED_INFO ||
                    'When enabled, chat and image generation models stay loaded in memory simultaneously. Requires more VRAM but avoids reloading models when switching between chat and image generation.'
                  }}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Checkbox id="keep-models-loaded" v-model="developerSettings.keepModelsLoaded" />
        </div>
        <div class="flex justify-between pr-4 items-center gap-4 mb-4">
          <div class="flex items-center gap-2">
            <Label class="whitespace-nowrap">Agent preset</Label>
            <TooltipProvider :delay-duration="200">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-[300px]">
                  Add the experimental "Agent" chat preset — the coding agent pointed at a folder
                  you pick, rather than at one task like Game Agent.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Checkbox
            id="agent-preset-enabled"
            :model-value="debugSettings.agentPresetEnabled"
            @update:model-value="(v) => setAgentPreset(v === true)"
          />
        </div>
        <template v-if="showDebugSettings">
          <div class="flex justify-between pr-4 items-center gap-4 mb-4">
            <div class="flex items-center gap-2">
              <Label class="whitespace-nowrap">Verbose agent logging</Label>
              <TooltipProvider :delay-duration="200">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" class="max-w-[300px]">
                    Write the agent turn lifecycle and every tool call into the app log. Useful when
                    an agent run misbehaves; noisy otherwise.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Checkbox id="verbose-agent-logging" v-model="developerSettings.verboseAgentLogging" />
          </div>
          <div class="flex justify-between pr-4 items-center gap-4 mb-4">
            <div class="flex items-center gap-2">
              <Label class="whitespace-nowrap">Use dummy media workflows</Label>
              <TooltipProvider :delay-duration="200">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" class="max-w-[300px]">
                    Offer the assistant nothing but the dummy workflows, which return placeholder
                    images, videos and 3D models instantly. Use it to verify media generation,
                    chaining and rendering without waiting for a real model.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Checkbox
              id="force-dummy-media-workflows"
              v-model="developerSettings.forceDummyMediaWorkflows"
            />
          </div>
          <div class="flex justify-between pr-4 items-center gap-4 mb-4">
            <div class="flex items-center gap-2">
              <Label class="whitespace-nowrap">Pretend Phison SSD</Label>
              <TooltipProvider :delay-duration="200">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" class="max-w-[300px]">
                    Skip the hardware probe and report a Phison aiDAPTIV+ SSD as present, so the
                    SSD-offload option can be exercised on any machine.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Checkbox
              id="pretend-phison-ssd"
              :model-value="debugSettings.phisonSsdDetected"
              @update:model-value="(v) => debugSettings.setPhisonSsdDetected(v === true)"
            />
          </div>
          <div class="flex flex-col gap-2 pr-4 mb-4">
            <Label>OEM vendor override</Label>
            <drop-down-new
              :items="oemVendorItems"
              :value="debugSettings.oemVendorOverride ?? NO_OEM_OVERRIDE"
              @change="
                (value) =>
                  debugSettings.setOemVendorOverride(value === NO_OEM_OVERRIDE ? null : value)
              "
            />
          </div>
          <div class="flex flex-col gap-2 pr-4 mb-4">
            <Label>Remote repository</Label>
            <Input
              v-model="debugSettings.remoteRepository"
              placeholder="intel/ai-playground"
              class="h-[30px] leading-[30px] rounded-md bg-card border-border text-foreground px-[3px]"
              @change="debugSettings.saveRemoteRepository()"
            />
          </div>
          <div class="flex flex-col gap-2 pr-4 mb-4">
            <Label>OpenVINO image-gen devices</Label>
            <Input
              v-model="debugSettings.openvinoImageGenDevices"
              placeholder="CPU, GPU"
              class="h-[30px] leading-[30px] rounded-md bg-card border-border text-foreground px-[3px]"
              @change="debugSettings.saveOpenvinoImageGenDevices()"
            />
          </div>
          <p class="text-xs text-muted-foreground pr-4 mb-4">
            The OEM, Phison and OpenVINO-device settings are read at startup — restart the app to
            see them take effect.
          </p>
        </template>
      </div>
      <div class="flex justify-between items-center">
        <SettingsHeading>
          {{
            i18nState.SETTINGS_PRESETS_MANAGEMENT ||
            languages.SETTINGS_PRESETS_MANAGEMENT ||
            'Presets Management'
          }}
        </SettingsHeading>
        <div class="flex pr-4 gap-2 items-center">
          <div :data-tooltip="i18nState.PRESET_RELOAD_INFO">
            <button
              class="svg-icon i-refresh w-5 h-5"
              @click="presetsStore.loadPresetsFromFiles"
            ></button>
          </div>
          <div :data-tooltip="i18nState.PRESET_DOWNLOAD_INFO">
            <button
              class="svg-icon i-download-cloud w-5 h-5"
              @click="loadPresetsFromIntel"
            ></button>
          </div>
        </div>
      </div>
      <div class="flex flex-col pt-5">
        <button
          :disabled="demoMode.enabled"
          @click="openSetupWizard"
          class="bg-primary hover:bg-primary/80 px-3 py-1.5 rounded-lg text-sm disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed"
        >
          {{ languages.SETTINGS_SETUP_WIZARD || 'Setup Wizard' }}
        </button>
      </div>
    </div>
  </DemoModeBlocker>
  <DemoModeSettings v-if="demoMode.showDemoToggle" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useModels } from '@/assets/js/store/models'
import { mapServiceNameToDisplayName, mapStatusToColor, mapToDisplayStatus } from '@/lib/utils.ts'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { usePresets } from '@/assets/js/store/presets'
import { useSpeechToText } from '@/assets/js/store/speechToText'
import { useTextToSpeech } from '@/assets/js/store/textToSpeech'
import { useDeveloperSettings } from '@/assets/js/store/developerSettings'
import { useDialogStore } from '@/assets/js/store/dialogs'
import { useDemoMode } from '@/assets/js/store/demoMode'
import * as toast from '@/assets/js/toast'
import LanguageSelector from '@/components/LanguageSelector.vue'
import ThemeSelector from '@/components/ThemeSelector.vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import DemoModeSettings from '@/components/DemoModeSettings.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import DemoModeBlocker from '@/components/DemoModeBlocker.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useDebugSettings, debugSettingsVisible } from '@/assets/js/store/debugSettings'

const cloudMode = useCloudMode()
const debugSettings = useDebugSettings()
const showDebugSettings = debugSettingsVisible()

async function setAgentPreset(enabled: boolean) {
  await debugSettings.setAgentPresetEnabled(enabled)
  await presetsStore.loadPresetsFromFiles()
}

// Vendors the OEM probe can report; `detectOem` treats anything else as unknown.
const NO_OEM_OVERRIDE = '__none__'
const oemVendorItems = [
  { label: 'No override (probe the firmware)', value: NO_OEM_OVERRIDE, active: true },
  { label: 'Acer', value: 'acer', active: true },
  { label: 'Unknown', value: 'unknown', active: true },
]
const demoMode = useDemoMode()
const setupWizardStore = useSetupWizard()
const backendServices = useBackendServices()
const models = useModels()
const presetsStore = usePresets()
const i18nState = useI18N().state
const languages = i18nState
const speechToText = useSpeechToText()
const textToSpeech = useTextToSpeech()
const developerSettings = useDeveloperSettings()
const dialogStore = useDialogStore()

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
  const components = backendServices.info.map((item) => ({
    serviceName: item.serviceName as string,
    status: item.status as BackendStatus,
  }))
  // Cloud Mode is a frontend-only component (remote OpenAI-compatible provider),
  // so it never appears in backendServices.info. Always surface it here so the status
  // panel lists it like a backend: "running" when the feature is enabled, otherwise
  // "not installed" (rather than hiding the row entirely when it's off).
  components.push({
    serviceName: 'cloud-mode',
    status: cloudMode.isFeatureEnabled ? 'running' : 'notInstalled',
  })
  return components
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

function openSetupWizard() {
  if (demoMode.enabled) return
  setupWizardStore.openWizard()
}
</script>

<!-- scoped: `[data-tooltip]` is a bare attribute selector, so unscoped it would claim
     every element in the app carrying that attribute, not just this panel's two. -->
<style scoped>
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
