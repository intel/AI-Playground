<template>
  <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
    <button class="mt-4" @click="resetPresetSettings">
      <div class="svg-icon i-refresh">Reset</div>
      {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { useQwen3TextToSpeech } from '@/assets/js/store/qwen3TextToSpeech'
import { useTextToSpeech } from '@/assets/js/store/textToSpeech'
import { useSpeechToText } from '@/assets/js/store/speechToText'
import { stopSpeaking } from '@/assets/js/speech/speechIO'
import { useActiveAudioPreset } from '@/assets/js/activeAudioPreset'
import * as toast from '@/assets/js/toast'

const languages = useI18N().state
const qwen3Tts = useQwen3TextToSpeech()
const textToSpeech = useTextToSpeech()
const speechToText = useSpeechToText()
const { isTtsPreset, isSttPreset } = useActiveAudioPreset()

// Created voices (with their previews) and endpoint credentials are user data, not preset settings.
function resetPresetSettings() {
  if (isTtsPreset.value) {
    // Stop the clip before swapping the voice under it.
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
</script>
