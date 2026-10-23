<template>
  <div class="flex flex-col gap-6 p-1">
    <PresetSelector
      type="chat"
      :categories="[AUDIO_CATEGORY]"
      :model-value="presetsStore.activePresetName || undefined"
      @update:model-value="handlePresetChange"
      @update:variant="handleVariantChange"
    />

    <!-- Text to Speech: a direct Qwen3-TTS / Kokoro synthesizer, no LLM controls. -->
    <SettingsTts v-if="isTtsPreset" />

    <!-- Speech to Text: a direct Whisper transcriber, no LLM controls. -->
    <SettingsStt v-else-if="isSttPreset" />

    <!-- Same reset affordance the Chat and workflow panels carry, so every preset
         offers a way back to its defaults. -->
    <div
      v-if="isTtsPreset || isSttPreset"
      class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2"
    >
      <button class="mt-4" @click="resetPresetSettings">
        <div class="svg-icon i-refresh">Reset</div>
        {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import PresetSelector from '@/components/PresetSelector.vue'
import SettingsTts from '@/components/SettingsTts.vue'
import SettingsStt from '@/components/SettingsStt.vue'
import { AUDIO_CATEGORY, usePresets, type ChatPreset } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { useI18N } from '@/assets/js/store/i18n'
import { useQwen3TextToSpeech } from '@/assets/js/store/qwen3TextToSpeech'
import { useTextToSpeech } from '@/assets/js/store/textToSpeech'
import { useSpeechToText } from '@/assets/js/store/speechToText'
import { stopSpeaking } from '@/assets/js/speech/speechIO'
import * as toast from '@/assets/js/toast'

const languages = useI18N().state
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const qwen3Tts = useQwen3TextToSpeech()
const textToSpeech = useTextToSpeech()
const speechToText = useSpeechToText()

const activeAudioPreset = computed(() => {
  const preset = presetsStore.activePresetWithVariant
  if (preset?.type === 'chat') return preset as ChatPreset
  return null
})

const isTtsPreset = computed(() => activeAudioPreset.value?.ttsPreset === true)
const isSttPreset = computed(() => activeAudioPreset.value?.sttPreset === true)

/**
 * Reset whichever Audio preset is active back to its defaults. Only the settings this
 * panel presents are touched: created voices (with their preview recordings) and the
 * external endpoints' credentials are user-owned data, not preset settings.
 */
function resetPresetSettings() {
  if (isTtsPreset.value) {
    // Engine defaults changed mid-playback: stop the clip, as the old store-side
    // reset did, before swapping the voice under it.
    stopSpeaking()
    textToSpeech.resetToDefaults()
    qwen3Tts.resetToDefaults()
  } else if (isSttPreset.value) {
    speechToText.resetToDefaults()
  } else {
    return
  }
  toast.success('Reset to preset defaults')
}

async function handlePresetChange(presetName: string) {
  const result = await presetSwitching.switchPreset(presetName, {
    skipModeSwitch: true, // We're already in audio mode
  })
  if (result.success) {
    toast.success(`Switched to ${presetName}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}

async function handleVariantChange(presetName: string, variantName: string | null) {
  if (!variantName) return
  const result = await presetSwitching.switchPreset(presetName, {
    variant: variantName,
    skipModeSwitch: true,
  })
  if (!result.success && result.error) {
    toast.error(`Failed to switch variant: ${result.error}`)
  }
}
</script>
