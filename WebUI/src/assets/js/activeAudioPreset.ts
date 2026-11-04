import { computed, watch } from 'vue'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets'
import { useProductMode } from '@/assets/js/store/productMode'
import { useTextToSpeech, type TtsEngine } from '@/assets/js/store/textToSpeech'

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
