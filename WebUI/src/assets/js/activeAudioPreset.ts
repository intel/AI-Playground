import { computed, watch } from 'vue'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets'
import { useProductMode } from '@/assets/js/store/productMode'
import { useQwen3TextToSpeech } from '@/assets/js/store/qwen3TextToSpeech'
import { useSpeechToText } from '@/assets/js/store/speechToText'
import { useTextToSpeech, type TtsEngine } from '@/assets/js/store/textToSpeech'
import { stopSpeaking } from '@/assets/js/speech/speechIO'

/** Which speech preset is active: Text to Speech, Speech to Text, or neither. */
export function useActiveAudioPreset() {
  const presets = usePresets()

  const activeAudioPreset = computed(() => {
    const preset = presets.activePresetWithVariant
    return preset?.type === 'chat' ? (preset as ChatPreset) : null
  })

  const isTtsPreset = computed(() => activeAudioPreset.value?.ttsPreset === true)
  const isSttPreset = computed(() => activeAudioPreset.value?.sttPreset === true)

  return { isTtsPreset, isSttPreset }
}

/**
 * Resets the active speech preset's engine settings, which are every Session's (ADR-0004).
 * Created voices and endpoint credentials are user data, so they survive.
 */
export function useSpeechSettingsReset() {
  const textToSpeech = useTextToSpeech()
  const qwen3Tts = useQwen3TextToSpeech()
  const speechToText = useSpeechToText()
  const { isTtsPreset, isSttPreset } = useActiveAudioPreset()

  function resetSpeechSettings(): boolean {
    if (isTtsPreset.value) {
      // Stop the clip before swapping the voice under it.
      stopSpeaking()
      textToSpeech.resetToDefaults()
      qwen3Tts.resetToDefaults()
      return true
    }
    if (isSttPreset.value) {
      speechToText.resetToDefaults()
      return true
    }
    return false
  }

  return { resetSpeechSettings }
}

/**
 * The TTS engines this machine offers: Qwen TTS always, Kokoro off NVIDIA, External
 * when enabled in App Settings. An engine that stops being offered falls back to Qwen TTS.
 */
export function useOfferedTtsEngines() {
  const textToSpeech = useTextToSpeech()
  const productMode = useProductMode()

  const offered = computed(() => {
    const engines: TtsEngine[] = ['qwen3']
    if (!productMode.isNvidiaModeSelected) engines.push('kokoro')
    if (textToSpeech.fallback.enabled) engines.push('external')
    return engines
  })

  watch(
    offered,
    (engines) => {
      if (!engines.includes(textToSpeech.selectedEngine)) textToSpeech.selectedEngine = 'qwen3'
    },
    { immediate: true },
  )

  return offered
}
