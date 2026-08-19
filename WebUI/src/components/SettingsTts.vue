<template>
  <div class="flex flex-col gap-4">
    <!-- Install guidance: the Qwen3-TTS backend is required for any synthesis. -->
    <p
      v-if="!qwen3BackendSetUp"
      class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
    >
      Install the Text To Speech backend from Settings → Installation Management to enable speech
      synthesis.
    </p>

    <!-- Model not yet downloaded for the selected voice: the weights install via the
         standard model-download popup (like every other model). -->
    <div
      v-else-if="!ttsModelDownloaded"
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

    <!-- Model row: a single fixed engine, shown where the LLM model picker normally is.
         The dot is greyed until the model weights are downloaded. -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
      <drop-down-new
        title="Model"
        :value="'qwen-tts'"
        :items="[{ label: 'Qwen TTS', value: 'qwen-tts', active: ttsModelDownloaded }]"
        :disabled="!ttsModelDownloaded"
        @change="() => {}"
      ></drop-down-new>
    </div>

    <!-- Hardware: which accelerator the TTS model loads on. Changing it restarts
         the backend so the model reloads on the chosen device. -->
    <div v-if="qwen3BackendSetUp" class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.SETTINGS_INFERENCE_DEVICE }}</Label>
      <device-selector backend="qwen3-tts-backend" name-only></device-selector>
    </div>

    <!-- Voice: preset speakers plus any voices you created. This is the voice used
         when the chat reads text aloud. -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Voice</Label>
      <drop-down-new
        title="Voice"
        :value="selectedVoiceValue"
        :items="voiceItems"
        @change="onSelectVoice"
      ></drop-down-new>
    </div>

    <!-- Language applies to synthesis. -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Language</Label>
      <drop-down-new
        title="Language"
        :value="qwen3Tts.defaultLanguage"
        :items="languageItems"
        @change="(v) => (qwen3Tts.defaultLanguage = v as Qwen3TtsLanguage)"
      ></drop-down-new>
    </div>

    <!-- Create a custom voice: describe a voice in words and save it. Saved voices
         appear in the Voice list above and can be used from chat by name. -->
    <div class="mt-2 flex flex-col gap-4 border-t border-border pt-4">
      <div>
        <h3 class="text-sm font-medium text-foreground">Create a custom voice</h3>
        <p class="text-xs text-muted-foreground">
          Describe a voice in words — timbre, age, accent, tone, and pace (e.g. “Authoritative
          American female voice speaking at a natural, brisk pace”). Save it to add it to your Voice
          list and use it in chat by name. A saved voice keeps its sound across sessions; use
          Re-roll below to draw a different speaker for the same description.
        </p>
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Name</Label>
        <Input
          v-model="newVoiceName"
          type="text"
          placeholder="e.g. Tammy"
          class="h-[30px] text-sm"
          @keyup.enter="saveCurrentVoice"
        />
      </div>

      <div class="grid grid-cols-[120px_1fr] items-start gap-4">
        <Label class="whitespace-nowrap pt-2">Description</Label>
        <Textarea
          v-model="newVoiceInstruct"
          placeholder="e.g. A calm middle-aged British man, warm and reassuring."
          class="min-h-[72px] text-sm"
        />
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Language</Label>
        <drop-down-new
          title="Language"
          :value="newVoiceLanguage"
          :items="languageItems"
          @change="(v) => (newVoiceLanguage = v as Qwen3TtsLanguage)"
        ></drop-down-new>
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <span></span>
        <div>
          <Button size="sm" :disabled="!canSaveVoice || savingVoice" @click="saveCurrentVoice">
            {{ savingVoice ? 'Preparing…' : 'Save voice' }}
          </Button>
        </div>
      </div>

      <!-- Manage saved voices. -->
      <div
        v-if="qwen3Tts.savedVoices.length > 0"
        class="grid grid-cols-[120px_1fr] items-start gap-4"
      >
        <Label class="whitespace-nowrap pt-1">Your voices</Label>
        <ul class="flex flex-col gap-1">
          <li
            v-for="voice in qwen3Tts.savedVoices"
            :key="voice.name"
            class="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-1"
          >
            <div class="min-w-0">
              <div class="text-sm text-foreground">{{ voice.name }}</div>
              <div class="truncate text-xs text-muted-foreground">{{ voice.instruct }}</div>
            </div>
            <div class="flex shrink-0 items-center gap-3">
              <!-- A saved voice keeps the same seed so it sounds the same every
                   time. Re-roll draws a different speaker for the same description
                   (useful when the current one sounds off — e.g. too slow). -->
              <button
                class="text-xs text-muted-foreground hover:text-foreground"
                title="Draw a different speaker for this description"
                @click="qwen3Tts.rerollVoiceSeed(voice.name)"
              >
                Re-roll
              </button>
              <button
                class="text-xs text-muted-foreground hover:text-destructive"
                @click="qwen3Tts.deleteVoice(voice.name)"
              >
                Remove
              </button>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import DropDownNew from '@/components/DropDownNew.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useQwen3TextToSpeech } from '@/assets/js/store/qwen3TextToSpeech'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { QWEN3_TTS_LANGUAGES, QWEN3_TTS_SPEAKERS } from '@/assets/js/qwen3TtsConstants'
import type { Qwen3TtsLanguage, Qwen3TtsSpeakerId } from '@/assets/js/qwen3TtsConstants'

const languages = useI18N().state
const qwen3Tts = useQwen3TextToSpeech()
const backendServices = useBackendServices()

const qwen3BackendSetUp = computed(
  () => backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')?.isSetUp === true,
)

// Whether the model for the currently-selected voice is present on disk. Preset
// voices and created voices use different weights, so this tracks the model the
// active voice needs (mode is set implicitly by the voice selection).
const ttsModelDownloaded = ref(false)
const installing = ref(false)

async function refreshModelInstalled() {
  if (!qwen3BackendSetUp.value) {
    ttsModelDownloaded.value = false
    return
  }
  try {
    ttsModelDownloaded.value = await qwen3Tts.isModelInstalled(qwen3Tts.defaultMode)
  } catch {
    ttsModelDownloaded.value = false
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

const languageItems = QWEN3_TTS_LANGUAGES.map((lang) => ({
  label: lang,
  value: lang,
  active: true,
}))

// --- Voice selection (presets + created voices in one list) ---
const voiceItems = computed(() => {
  const presets = QWEN3_TTS_SPEAKERS.map((sp) => ({
    label: `${sp.id} — ${sp.nativeLanguage}`,
    value: `preset:${sp.id}`,
    active: true,
    description: sp.description,
  }))
  const saved = qwen3Tts.savedVoices.map((v) => ({
    label: `${v.name} (your voice)`,
    value: `saved:${v.name}`,
    active: true,
    description: v.instruct,
  }))
  return [...presets, ...saved]
})

// Which voice is active: a saved voice by name (preferred) or by matching
// description (older persisted sessions), else a preset speaker.
const selectedVoiceValue = computed(() => {
  if (qwen3Tts.defaultMode === 'voice_design') {
    const byName = qwen3Tts.defaultVoiceName
      ? qwen3Tts.savedVoices.find(
          (v) => v.name.toLowerCase() === qwen3Tts.defaultVoiceName.toLowerCase(),
        )
      : undefined
    if (byName) return `saved:${byName.name}`
    const match = qwen3Tts.savedVoices.find((v) => v.instruct === qwen3Tts.defaultInstruct)
    return match ? `saved:${match.name}` : ''
  }
  return `preset:${qwen3Tts.defaultSpeaker}`
})

function onSelectVoice(value: string) {
  if (value.startsWith('saved:')) {
    qwen3Tts.applySavedVoice(value.slice('saved:'.length))
  } else {
    qwen3Tts.applyPresetSpeaker(value.replace(/^preset:/, '') as Qwen3TtsSpeakerId)
  }
}

// --- Create-a-voice form (kept separate from the active selection) ---
const newVoiceName = ref('')
const newVoiceInstruct = ref('')
const newVoiceLanguage = ref<Qwen3TtsLanguage>('Auto')

const canSaveVoice = computed(
  () => newVoiceName.value.trim().length > 0 && newVoiceInstruct.value.trim().length > 0,
)

const savingVoice = ref(false)

async function saveCurrentVoice() {
  if (!canSaveVoice.value || savingVoice.value) return
  const name = newVoiceName.value.trim()
  qwen3Tts.saveVoice({
    name,
    instruct: newVoiceInstruct.value,
    language: newVoiceLanguage.value,
  })
  // Make the freshly created voice the active one, and reset the form.
  qwen3Tts.applySavedVoice(name)
  newVoiceName.value = ''
  newVoiceInstruct.value = ''
  newVoiceLanguage.value = 'Auto'

  // Created voices need the voice-design weights, which are a different model
  // from the preset speakers'. Offer the download here — at the moment the user
  // creates the voice — instead of ambushing them mid-chat on first use. The
  // voice stays saved either way if they cancel.
  savingVoice.value = true
  try {
    await qwen3Tts.ensureModelInstalled('voice_design')
  } catch {
    // Cancellation / failure is surfaced by the download dialog itself.
  } finally {
    savingVoice.value = false
    await refreshModelInstalled()
  }
}
</script>
