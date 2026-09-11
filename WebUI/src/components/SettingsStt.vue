<template>
  <div class="flex flex-col gap-4">
    <!-- Install guidance: Whisper needs OpenVINO; External needs an endpoint set up
         in App Settings. Shown when neither is usable. -->
    <p
      v-if="
        !openVinoSetUp && !speechToText.isStandaloneAvailable && !speechToText.isExternalAvailable
      "
      class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
    >
      Install the OpenVINO or standalone Whisper backend from Settings → Installation Management, or
      enable an external transcription endpoint in App Settings → External speech endpoints.
    </p>

    <!-- Backend row: pick the transcription backend (OpenVINO / Standalone / External).
         The dot reflects usability of each. -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Backend</Label>
      <drop-down-new
        title="Backend"
        :value="speechToText.selectedSttEngine"
        :items="engineItems"
        @change="(v) => (speechToText.selectedSttEngine = v as SttEngine)"
      ></drop-down-new>
    </div>

    <!-- OpenVINO (OVMS) Whisper: pick the model, and (when installed) the device.
         OVMS takes the model per server launch, so switching restarts it on the
         next transcription. -->
    <template v-if="speechToText.selectedSttEngine === 'whisper'">
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
        <drop-down-new
          title="Model"
          :value="speechToText.selectedOvmsModel"
          :items="ovmsModelItems"
          @change="(v) => (speechToText.selectedOvmsModel = v as WhisperOvmsModel)"
        ></drop-down-new>
      </div>
      <!-- Hardware: which accelerator the Whisper model loads on. -->
      <div
        v-if="openVinoSetUp && sttDevices.length > 0"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <Label class="whitespace-nowrap">{{ languages.SETTINGS_INFERENCE_DEVICE }}</Label>
        <drop-down-new
          title="STT Device"
          :value="selectedSttDevice?.id"
          :items="sttDeviceItems"
          @change="selectSttDevice"
        ></drop-down-new>
      </div>
    </template>

    <!-- Standalone (torch) Whisper: pick the model, and (when installed) the device. -->
    <template v-if="speechToText.selectedSttEngine === 'standalone'">
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
        <drop-down-new
          title="Model"
          :value="speechToText.selectedStandaloneModel"
          :items="standaloneModelItems"
          @change="(v) => (speechToText.selectedStandaloneModel = v as WhisperStandaloneModel)"
        ></drop-down-new>
      </div>
      <div
        v-if="speechToText.isStandaloneAvailable"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <Label class="whitespace-nowrap">{{ languages.SETTINGS_INFERENCE_DEVICE }}</Label>
        <device-selector backend="whisper-backend" name-only></device-selector>
      </div>
      <p v-else class="text-xs text-amber-500">
        Install the standalone Whisper backend from Settings → Installation Management to use this
        engine.
      </p>
    </template>

    <!-- External endpoint config: enabled via the checkbox in App Settings; the
         endpoint itself is configured here. Any OpenAI-compatible transcription
         server (e.g. a local whisper.cpp whisper-server). -->
    <template v-if="speechToText.selectedSttEngine === 'external'">
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Base URL</Label>
        <Input v-model="speechToText.fallback.baseUrl" placeholder="http://127.0.0.1:2022/v1" />
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Model</Label>
        <Input v-model="speechToText.fallback.model" placeholder="whisper-1" />
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">API key</Label>
        <Input v-model="speechToText.fallback.apiKey" type="password" placeholder="(optional)" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import DropDownNew from '@/components/DropDownNew.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useSpeechToText } from '@/assets/js/store/speechToText'
import type { SttEngine } from '@/assets/js/store/speechToText'
import { WHISPER_OVMS_MODELS, WHISPER_STANDALONE_MODELS } from '@/assets/js/whisperConstants'
import type { WhisperOvmsModel, WhisperStandaloneModel } from '@/assets/js/whisperConstants'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useModels } from '@/assets/js/store/models'
import { useDialogStore } from '@/assets/js/store/dialogs'

const languages = useI18N().state
const speechToText = useSpeechToText()
const backendServices = useBackendServices()
const models = useModels()
const dialogs = useDialogStore()

const openVinoSetUp = computed(
  () => backendServices.info.find((s) => s.serviceName === 'openvino-backend')?.isSetUp === true,
)

// Which engines are offered (OpenVINO only off NVIDIA, Standalone only when its
// optional backend feature is on, External always) is decided by the store, so the
// dropdown and every other consumer agree. Here we only add the label and the dot,
// which reflects usability.
const ENGINE_LABELS: Record<SttEngine, string> = {
  whisper: 'OpenVINO',
  standalone: 'Standalone',
  external: 'External endpoint',
}

const engineItems = computed(() =>
  speechToText.offeredSttEngines.map((engine) => ({
    label: ENGINE_LABELS[engine],
    value: engine,
    active:
      engine === 'whisper'
        ? speechToText.isWhisperAvailable
        : engine === 'standalone'
          ? speechToText.isStandaloneAvailable
          : speechToText.isExternalAvailable,
  })),
)

// Downloaded state per selectable Whisper model (both engines share the STT model
// dir), so the dropdown dot is grey until the weights are on disk. Re-checked on
// mount, when the backend/engine changes, and whenever the model-download popup
// closes — the weights are pulled by `ensureStandaloneReady` / `ensureWhisperReady`
// through that popup, so without the last watch the dot stays grey until the panel
// is remounted.
const downloaded = ref<Record<string, boolean>>({})
async function refreshDownloaded() {
  try {
    const entries = await Promise.all(
      [...WHISPER_STANDALONE_MODELS, ...WHISPER_OVMS_MODELS].map(
        async (m) => [m.repo, await models.checkTranscriptionModelExists(m.repo)] as const,
      ),
    )
    downloaded.value = Object.fromEntries(entries)
  } catch {
    downloaded.value = {}
  }
}
onMounted(refreshDownloaded)
watch(() => speechToText.isStandaloneAvailable, refreshDownloaded)
watch(() => speechToText.selectedSttEngine, refreshDownloaded)
watch(
  () => dialogs.downloadDialogVisible,
  (visible) => {
    if (!visible) refreshDownloaded()
  },
)

const standaloneModelItems = computed(() =>
  WHISPER_STANDALONE_MODELS.map((m) => ({
    label: m.label,
    value: m.repo,
    active: downloaded.value[m.repo] === true,
  })),
)

const ovmsModelItems = computed(() =>
  WHISPER_OVMS_MODELS.map((m) => ({
    label: m.label,
    value: m.repo,
    active: downloaded.value[m.repo] === true,
  })),
)

// Note: keeping the selected engine valid for the current mode/flags is handled in
// the speechToText store (preferredSttEngine), so it applies to every consumer.

// STT device selection (Whisper loads on a dedicated OVMS device list, distinct
// from the LLM device list DeviceSelector uses). Mirrors the logic previously in
// SettingsBasic.vue.
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
</script>
