<template>
  <div class="flex flex-col gap-4">
    <!-- Install guidance: the Qwen3-TTS backend is required for the Qwen engine.
         Only relevant while Qwen is the selected engine (Kokoro runs on OpenVINO). -->
    <p
      v-if="textToSpeech.selectedEngine === 'qwen3' && !qwen3BackendSetUp"
      class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
    >
      Install the Text To Speech backend from Settings → Installation Management to enable speech
      synthesis.
    </p>

    <!-- Model not yet downloaded for the selected voice: the weights install via the
         standard model-download popup (like every other model). Qwen engine only. -->
    <div
      v-else-if="textToSpeech.selectedEngine === 'qwen3' && !ttsModelDownloaded"
      class="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
    >
      <span>
        {{
          qwen3Tts.defaultMode === 'voice_design'
            ? "The model for created voices isn't installed yet."
            : "The model for the built-in voices isn't installed yet."
        }}
        Built-in voices and voices you create use different models, so each is downloaded once,
        separately.
      </span>
      <Button size="sm" :disabled="installing" @click="installModel">
        {{ installing ? 'Installing…' : 'Install model' }}
      </Button>
    </div>

    <!-- Model row: pick the synthesis engine. Qwen TTS runs on its own backend (every
         product mode); Kokoro runs on OpenVINO (offered only in non-NVIDIA modes);
         External uses the endpoint configured in App Settings (offered only when it's
         enabled there). -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
      <drop-down-new
        title="Model"
        :value="textToSpeech.selectedEngine"
        :items="engineItems"
        @change="(v) => (textToSpeech.selectedEngine = v as TtsEngine)"
      ></drop-down-new>
    </div>

    <!-- Hardware: which accelerator the TTS model loads on. Changing it restarts
         the backend only if it is already running. -->
    <div
      v-if="textToSpeech.selectedEngine === 'qwen3' && qwen3BackendSetUp"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">{{ languages.SETTINGS_INFERENCE_DEVICE }}</Label>
      <device-selector backend="qwen3-tts-backend" name-only></device-selector>
    </div>

    <div
      v-else-if="textToSpeech.selectedEngine === 'kokoro'"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">{{ languages.SETTINGS_INFERENCE_DEVICE }}</Label>
      <device-selector backend="openvino-backend" name-only></device-selector>
    </div>

    <!-- Enabled via the checkbox in App Settings; the endpoint itself is configured
         here. Points at any OpenAI-compatible /v1/audio/speech server. -->
    <template v-else-if="textToSpeech.selectedEngine === 'external'">
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Base URL</Label>
        <Input v-model="textToSpeech.fallback.baseUrl" placeholder="http://127.0.0.1:8080/v1" />
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Model</Label>
        <Input v-model="textToSpeech.fallback.model" placeholder="tts-1" />
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Voice</Label>
        <Input v-model="textToSpeech.fallback.voice" placeholder="(optional)" />
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">API key</Label>
        <Input v-model="textToSpeech.fallback.apiKey" type="password" placeholder="(optional)" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import DropDownNew from '@/components/DropDownNew.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useQwen3TextToSpeech } from '@/assets/js/store/qwen3TextToSpeech'
import { useTextToSpeech } from '@/assets/js/store/textToSpeech'
import type { TtsEngine } from '@/assets/js/store/textToSpeech'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useOfferedTtsEngines } from '@/assets/js/activeAudioPreset'

const languages = useI18N().state
const qwen3Tts = useQwen3TextToSpeech()
const textToSpeech = useTextToSpeech()
const backendServices = useBackendServices()
const offeredEngines = useOfferedTtsEngines()

const qwen3BackendSetUp = computed(
  () => backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')?.isSetUp === true,
)

// Qwen TTS ships as two separate downloads — one for the built-in voices
// (`custom_voice`) and one for created voices (`voice_design`) — so track each.
const customVoiceModelDownloaded = ref(false)
const voiceDesignModelDownloaded = ref(false)
const installing = ref(false)

// The model the active voice needs (mode is set implicitly by the voice selection).
const ttsModelDownloaded = computed(() =>
  qwen3Tts.defaultMode === 'voice_design'
    ? voiceDesignModelDownloaded.value
    : customVoiceModelDownloaded.value,
)

// Engine dot: full when both models are on disk, half when one is, grey when neither.
const ttsModelsDownloadedCount = computed(
  () => Number(customVoiceModelDownloaded.value) + Number(voiceDesignModelDownloaded.value),
)

type EngineItem = {
  label: string
  value: string
  active: boolean
  partial?: boolean
  description?: string
}

const engineItems = computed(() =>
  offeredEngines.value.map((engine): EngineItem => {
    if (engine === 'kokoro') {
      return { label: 'Kokoro (OpenVINO)', value: engine, active: textToSpeech.isKokoroAvailable }
    }
    if (engine === 'external') {
      return { label: 'External endpoint', value: engine, active: textToSpeech.isExternalAvailable }
    }
    return {
      label: 'Qwen TTS',
      value: engine,
      active: ttsModelsDownloadedCount.value === 2,
      partial: ttsModelsDownloadedCount.value === 1,
      description: `Built-in voices model: ${customVoiceModelDownloaded.value ? 'downloaded' : 'not downloaded'}. Created voices model: ${voiceDesignModelDownloaded.value ? 'downloaded' : 'not downloaded'}.`,
    }
  }),
)

async function refreshModelInstalled() {
  if (!qwen3BackendSetUp.value) {
    customVoiceModelDownloaded.value = false
    voiceDesignModelDownloaded.value = false
    return
  }
  try {
    const [customVoice, voiceDesign] = await Promise.all([
      qwen3Tts.isModelInstalled('custom_voice'),
      qwen3Tts.isModelInstalled('voice_design'),
    ])
    customVoiceModelDownloaded.value = customVoice
    voiceDesignModelDownloaded.value = voiceDesign
  } catch {
    customVoiceModelDownloaded.value = false
    voiceDesignModelDownloaded.value = false
  }
}

async function installModel() {
  installing.value = true
  try {
    await qwen3Tts.ensureModelInstalled(qwen3Tts.defaultMode)
    await refreshModelInstalled()
  } catch {
    // Cancellation / failure is surfaced by the download dialog itself.
  } finally {
    installing.value = false
  }
}

onMounted(refreshModelInstalled)
watch(qwen3BackendSetUp, refreshModelInstalled)
watch(() => qwen3Tts.defaultMode, refreshModelInstalled)
</script>
