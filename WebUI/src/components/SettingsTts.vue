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

    <!-- === Qwen3-TTS engine === -->
    <template v-if="textToSpeech.selectedEngine === 'qwen3'">
      <!-- Hardware: which accelerator the TTS model loads on. Changing it restarts
           the backend only if it is already running. -->
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
    </template>

    <!-- === Kokoro (OpenVINO) engine === -->
    <template v-else-if="textToSpeech.selectedEngine === 'kokoro'">
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">{{ languages.SETTINGS_INFERENCE_DEVICE }}</Label>
        <device-selector backend="openvino-backend" name-only></device-selector>
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Voice</Label>
        <drop-down-new
          title="Voice"
          :value="textToSpeech.selectedKokoroVoice"
          :items="kokoroVoiceItems"
          @change="(v) => (textToSpeech.selectedKokoroVoice = v as KokoroVoice)"
        ></drop-down-new>
      </div>
    </template>

    <!-- === External endpoint engine === -->
    <!-- Enabled via the checkbox in App Settings; the endpoint itself is configured
         here. Points at any OpenAI-compatible /v1/audio/speech server. -->
    <template v-else>
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

    <!-- Note: "Speak replies" (auto-play / Home Agent voice replies) is not a TTS
         preset setting — it applies to every preset, so it lives with the Home Agent
         settings (see SettingsChat.vue). -->

    <!-- Create a custom voice: describe a voice in words and save it. Saved voices
         appear in the Voice list above and can be used from chat by name. Qwen3 only. -->
    <div
      v-if="textToSpeech.selectedEngine === 'qwen3'"
      class="mt-2 flex flex-col gap-4 border-t border-border pt-4"
    >
      <div>
        <SettingsHeading sub>{{
          editingVoiceName ? 'Edit voice' : 'Create a custom voice'
        }}</SettingsHeading>
        <p class="text-xs text-muted-foreground">
          Describe a voice in words — timbre, age, accent, tone, and pace (e.g. “Authoritative
          American female voice speaking at a natural, brisk pace”). Saving previews the voice and
          adds it to your Voice list, so you can use it in chat by name. The preview is kept as the
          voice's reference recording, so it sounds the same whatever it goes on to say. The seed
          only decides which speaker the description draws right now: roll it for a different one.
        </p>
        <p v-if="editingVoiceName" class="pt-1 text-xs text-primary">
          Editing “{{ editingVoiceName }}”. Saving under the same name replaces it.
          <button class="underline hover:text-foreground" @click="resetVoiceForm">
            Create a new voice instead
          </button>
        </p>
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Name</Label>
        <!-- No Enter-to-save: this button now generates and plays audio, which is
             too heavy an action to fire from a stray keypress in a text field. -->
        <Input
          v-model="newVoiceName"
          type="text"
          placeholder="e.g. Tammy"
          class="h-[30px] text-sm"
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

      <!-- Same seed row as the image workflows: type one in, roll the dice for a
           different speaker, or reset to the one this name + description imply. -->
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <div class="flex w-[120px] min-w-0 items-center justify-between gap-2">
          <Label class="min-w-0 truncate whitespace-nowrap">
            {{ languages.SETTINGS_MODEL_SEED }}
          </Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info h-4 w-4 shrink-0 cursor-help opacity-50" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
                A description is sampled, so it draws a different speaker every time unless the
                sampler is seeded. This seed fixes which speaker you get when you save — roll it to
                draw another. It is not what keeps the voice afterwards: once saved, the voice is
                reproduced from its preview recording.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <random-number
          v-model:value="newVoiceSeed"
          :default="derivedSeed"
          :min="0"
          :max="2147483647"
          :scale="1"
          @change:current="seedTouched = true"
        ></random-number>
      </div>

      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <span></span>
        <div>
          <Button size="sm" :disabled="!canSaveVoice || savingVoice" @click="saveCurrentVoice">
            {{ savingVoiceLabel }}
          </Button>
        </div>
      </div>

      <!-- Manage saved voices. `minmax(0,1fr)` + `min-w-0`, not a plain `1fr`: a
           `1fr` track is `minmax(auto,1fr)`, whose floor is the row's min-content
           width — so a long voice description widened the track past the sidebar and
           pushed the row's action buttons off screen instead of being truncated. -->
      <div
        v-if="qwen3Tts.savedVoices.length > 0"
        class="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-4"
      >
        <Label class="whitespace-nowrap pt-1">Your voices</Label>
        <!-- `list-none pl-0`: Preflight's list reset does not reach this <ul>, so the
             UA's 20px `padding-inline-start` survived and inset every voice card 20px
             right of the pickers above it (and made it 20px narrower). -->
        <ul class="flex min-w-0 list-none flex-col gap-1 pl-0">
          <li
            v-for="voice in qwen3Tts.savedVoices"
            :key="voice.name"
            class="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-1"
          >
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm text-foreground" :title="voice.name">
                {{ voice.name }}
              </div>
              <!-- The full description only fits in a tooltip; the row keeps to one line. -->
              <div class="truncate text-xs text-muted-foreground" :title="voice.instruct">
                {{ voice.instruct }}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <!-- Plays the WAV saved when the voice was created — no synthesis, so
                   no model load and no wait. That recording is also what later
                   synthesis clones, so this is exactly how the voice will sound.
                   Voices saved before previews existed have no file; re-saving them
                   creates one (and makes them reproducible). -->
              <button
                class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                :aria-label="`Play ${voice.name}`"
                :title="
                  voice.previewFilePath
                    ? `Play ${voice.name}`
                    : 'No preview yet — re-save this voice so it can be reproduced exactly'
                "
                :disabled="!voice.previewFilePath"
                @click="togglePreview(voice)"
              >
                <span
                  class="svg-icon h-4 w-4"
                  :class="playingVoiceName === voice.name ? 'i-stop' : 'i-speaker'"
                ></span>
              </button>
              <button
                class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                :aria-label="`Edit ${voice.name}`"
                :title="`Edit ${voice.name}`"
                @click="editVoice(voice)"
              >
                <span class="svg-icon i-pen h-4 w-4"></span>
              </button>
              <button
                class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-destructive"
                :aria-label="`Delete ${voice.name}`"
                :title="`Delete ${voice.name}`"
                @click="removeVoice(voice.name)"
              >
                <span class="svg-icon i-delete h-4 w-4"></span>
              </button>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import DropDownNew from '@/components/DropDownNew.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import RandomNumber from '@/components/RandomNumber.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useQwen3TextToSpeech } from '@/assets/js/store/qwen3TextToSpeech'
import { useTextToSpeech, KOKORO_VOICES } from '@/assets/js/store/textToSpeech'
import type { TtsEngine, KokoroVoice } from '@/assets/js/store/textToSpeech'
import { useProductMode } from '@/assets/js/store/productMode'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useDialogStore } from '@/assets/js/store/dialogs'
import { useErrors } from '@/assets/js/store/errors'
import * as toast from '@/assets/js/toast'
import { stableVoiceSeed } from '@/lib/ttsVoiceSeed'
import { voicePreviewFileName, voicePreviewSentence } from '@/lib/ttsVoicePreview'
import { QWEN3_TTS_LANGUAGES, QWEN3_TTS_SPEAKERS } from '@/assets/js/qwen3TtsConstants'
import type {
  Qwen3TtsLanguage,
  Qwen3TtsSavedVoice,
  Qwen3TtsSpeakerId,
} from '@/assets/js/qwen3TtsConstants'

const languages = useI18N().state
const qwen3Tts = useQwen3TextToSpeech()
const textToSpeech = useTextToSpeech()
const productMode = useProductMode()
const backendServices = useBackendServices()
const dialogs = useDialogStore()
const errors = useErrors()

const kokoroVoiceItems = KOKORO_VOICES.map((v) => ({ label: v, value: v, active: true }))

const qwen3BackendSetUp = computed(
  () => backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')?.isSetUp === true,
)

// Qwen TTS ships as two separate downloads — one for the built-in voices
// (`custom_voice`) and one for created voices (`voice_design`) — so track each.
const customVoiceModelDownloaded = ref(false)
const voiceDesignModelDownloaded = ref(false)
const installing = ref(false)

// Whether the model for the currently-selected voice is present on disk. Preset
// voices and created voices use different weights, so this tracks the model the
// active voice needs (mode is set implicitly by the voice selection).
const ttsModelDownloaded = computed(() =>
  qwen3Tts.defaultMode === 'voice_design'
    ? voiceDesignModelDownloaded.value
    : customVoiceModelDownloaded.value,
)

// How many of the two models are on disk. Drives the engine dot: full when both
// are there, half when one is (the engine works, but the other voice kind still
// needs a download), grey when neither is.
const ttsModelsDownloadedCount = computed(
  () => Number(customVoiceModelDownloaded.value) + Number(voiceDesignModelDownloaded.value),
)

// Engine picker: Qwen TTS (always), Kokoro (only in non-NVIDIA modes), and External
// endpoint (only when enabled in App Settings). The dot reflects usability.
type EngineItem = {
  label: string
  value: string
  active: boolean
  partial?: boolean
  description?: string
}

const engineItems = computed(() => {
  const items: EngineItem[] = [
    {
      label: 'Qwen TTS',
      value: 'qwen3',
      active: ttsModelsDownloadedCount.value === 2,
      partial: ttsModelsDownloadedCount.value === 1,
      description: `Built-in voices model: ${customVoiceModelDownloaded.value ? 'downloaded' : 'not downloaded'}. Created voices model: ${voiceDesignModelDownloaded.value ? 'downloaded' : 'not downloaded'}.`,
    },
  ]
  if (!productMode.isNvidiaModeSelected) {
    items.push({
      label: 'Kokoro (OpenVINO)',
      value: 'kokoro',
      active: textToSpeech.isKokoroAvailable,
    })
  }
  if (textToSpeech.fallback.enabled) {
    items.push({
      label: 'External endpoint',
      value: 'external',
      active: textToSpeech.isExternalAvailable,
    })
  }
  return items
})

// If the selected engine is no longer offered (e.g. Kokoro after switching to NVIDIA
// mode, or External after disabling the fallback), fall back to Qwen TTS.
watch(
  engineItems,
  (items) => {
    if (!items.some((i) => i.value === textToSpeech.selectedEngine)) {
      textToSpeech.selectedEngine = 'qwen3'
    }
  },
  { immediate: true },
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

// --- Create / edit a voice (kept separate from the active selection) ---
const newVoiceName = ref('')
const newVoiceInstruct = ref('')
const newVoiceLanguage = ref<Qwen3TtsLanguage>('Auto')
const newVoiceSeed = ref(stableVoiceSeed('', ''))
/**
 * Whether the user has taken the seed over (typed one, rolled the dice, or reset).
 * Until they do, the seed tracks the description — otherwise every voice created
 * without touching the row would share the one seed the empty form started with.
 */
const seedTouched = ref(false)
/** Name of the voice being edited, so saving knows it is replacing rather than adding. */
const editingVoiceName = ref('')

const canSaveVoice = computed(
  () => newVoiceName.value.trim().length > 0 && newVoiceInstruct.value.trim().length > 0,
)

// The seed the current name + description imply. The seed row's reset button returns
// here, which is also the seed a voice saved before the row existed already had.
const derivedSeed = computed(() => stableVoiceSeed(newVoiceName.value, newVoiceInstruct.value))

watch(derivedSeed, (seed) => {
  if (!seedTouched.value) newVoiceSeed.value = seed
})

const savingVoice = ref(false)
const savingPhase = ref<'idle' | 'loading' | 'generating'>('idle')
const savingVoiceLabel = computed(() => {
  if (savingPhase.value === 'loading') return 'Loading voice model…'
  if (savingPhase.value === 'generating') return 'Generating preview…'
  return 'Save & preview'
})

function resetVoiceForm() {
  newVoiceName.value = ''
  newVoiceInstruct.value = ''
  newVoiceLanguage.value = 'Auto'
  newVoiceSeed.value = derivedSeed.value
  seedTouched.value = false
  editingVoiceName.value = ''
}

/** Load a saved voice back into the form so it can be adjusted and re-saved. */
function editVoice(voice: Qwen3TtsSavedVoice) {
  newVoiceName.value = voice.name
  newVoiceInstruct.value = voice.instruct
  newVoiceLanguage.value = voice.language ?? 'Auto'
  // The loaded voice's pinned seed is the point of editing it — don't let the
  // description watcher overwrite it.
  newVoiceSeed.value = voice.seed ?? stableVoiceSeed(voice.name, voice.instruct)
  seedTouched.value = true
  editingVoiceName.value = voice.name
}

async function removeVoice(name: string) {
  // Stop first: the preview file is about to be deleted from under the player.
  if (playingVoiceName.value === name) stopPreview()
  if (editingVoiceName.value.toLowerCase() === name.toLowerCase()) resetVoiceForm()
  await qwen3Tts.deleteVoice(name)
}

/**
 * Save & preview: synthesize "Hi, I'm <name>" with exactly the description, language
 * and seed on the form, play it, then store the voice together with that WAV. The
 * order matters — the user hears the voice before it is committed, and the file the
 * card plays later is the very take they approved.
 *
 * A voice is only saved once its preview generated: a failed or cancelled synthesis
 * leaves the form untouched so the input can be retried rather than retyped.
 */
async function saveCurrentVoice() {
  if (!canSaveVoice.value || savingVoice.value) return
  const name = newVoiceName.value.trim()
  const instruct = newVoiceInstruct.value.trim()
  const language = newVoiceLanguage.value
  const seed = newVoiceSeed.value

  // Overwriting is destructive (the old speaker is gone), so it needs a yes —
  // whether the user got here via Edit or by retyping an existing name.
  const clash = qwen3Tts.resolveVoice(name)
  if (clash) {
    const confirmed = await dialogs.requestConfirmation(
      `A voice named **${clash.name}** already exists. Saving replaces its description, ` +
        `language and seed — the current speaker will be gone.`,
    )
    if (!confirmed) return
  }

  savingVoice.value = true
  try {
    // A created voice needs two checkpoints, neither of them the preset speakers':
    // voice design *invents* it here, and voice cloning *reproduces* it later from
    // the preview. Fetch both now, at the one moment the user is deliberately making
    // a voice, so that using it never ambushes them with a download mid-chat.
    savingPhase.value = 'loading'
    await qwen3Tts.ensureModelInstalled('voice_design')
    await qwen3Tts.ensureModelInstalled('voice_clone')
    if (!(await qwen3Tts.isModelLoaded('voice_design'))) {
      await qwen3Tts.ensureModelLoaded('voice_design')
    }

    savingPhase.value = 'generating'
    const result = await qwen3Tts.synthesize({
      text: voicePreviewSentence(name),
      language,
      instruct,
      mode: 'voice_design',
      seed,
      // Draw a new speaker: without this, re-saving a voice that is currently active
      // would clone its old preview and the rolled seed would appear to do nothing.
      designNewVoice: true,
    })

    // One file per voice (overwrite), so re-saving replaces its preview instead of
    // leaving the previous take orphaned in the audio folder.
    const previewFilePath = await qwen3Tts.saveWavToDisk(
      result.audioBase64,
      voicePreviewFileName(name),
      { overwrite: true },
    )

    await playPreviewFile(previewFilePath, name)

    qwen3Tts.saveVoice({ name, instruct, language, seed, previewFilePath })
    // Make the just-heard voice the active one, and clear the form.
    qwen3Tts.applySavedVoice(name)
    resetVoiceForm()
    toast.success(`Saved voice "${name}"`)
  } catch (error) {
    // A cancelled model download is a decision, not a failure.
    if (error instanceof Error && /cancel/i.test(error.message)) return
    errors.report(error, {
      category: 'inference',
      code: 'inference/tts-failed',
      userMessage: `Could not preview the voice: ${error instanceof Error ? error.message : error}`,
      surface: 'toast',
    })
  } finally {
    savingPhase.value = 'idle'
    savingVoice.value = false
    await refreshModelInstalled()
  }
}

// --- Preview playback -------------------------------------------------------
// One shared element: starting a preview stops whichever was playing, so two
// voices can never talk over each other.
let previewAudio: HTMLAudioElement | null = null
const playingVoiceName = ref('')

function stopPreview() {
  if (previewAudio) {
    previewAudio.pause()
    previewAudio.src = ''
    previewAudio = null
  }
  playingVoiceName.value = ''
}

/** Play a preview WAV off disk. No synthesis — the file is the saved take. */
async function playPreviewFile(filePath: string, voiceName: string) {
  stopPreview()
  const result = await window.electronAPI.readLocalAudioAsDataUri(filePath)
  if (!result.success || !result.dataUri) {
    toast.error(result.error ?? 'Could not load the voice preview')
    return
  }
  const audio = new Audio(result.dataUri)
  previewAudio = audio
  playingVoiceName.value = voiceName
  audio.onended = stopPreview
  audio.onerror = stopPreview
  await audio.play().catch(() => stopPreview())
}

function togglePreview(voice: Qwen3TtsSavedVoice) {
  if (playingVoiceName.value === voice.name) {
    stopPreview()
    return
  }
  if (!voice.previewFilePath) return
  void playPreviewFile(voice.previewFilePath, voice.name)
}

onUnmounted(stopPreview)
</script>
