import { computed } from 'vue'
import { HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'
import { useI18N } from '@/assets/js/store/i18n'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets'

/** The active chat preset, and whether it is the Home Agent's — whose settings are every thread's. */
export function useActiveChatPreset() {
  const presets = usePresets()
  const languages = useI18N().state

  const activeChatPreset = computed(() => {
    const preset = presets.activePresetWithVariant
    return preset?.type === 'chat' ? (preset as ChatPreset) : null
  })

  const isHomeAgentPresetActive = computed(
    () => presets.activePresetName === HOME_AGENT_CHAT_PRESET_NAME,
  )

  // These knobs reach every Home Agent conversation, so a bad change can lock out remote access.
  const machineNote = computed(() =>
    isHomeAgentPresetActive.value ? languages.HOME_AGENT_SETTINGS_NOTE : undefined,
  )

  return { activeChatPreset, isHomeAgentPresetActive, machineNote }
}
