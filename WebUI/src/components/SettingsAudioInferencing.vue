<template>
  <SettingsTabLayout>
    <template #picker>
      <PresetSelector
        type="chat"
        :categories="[AUDIO_CATEGORY]"
        :model-value="presetsStore.activePresetName || undefined"
        @update:model-value="changePreset"
        @update:variant="changeVariant"
      />
    </template>

    <!-- The speech engines are global (ADR-0004), so their settings apply to all sessions. -->
    <template v-if="isTtsPreset || isSttPreset" #machine>
      <SettingsTtsInferencing v-if="isTtsPreset" />
      <SettingsStt v-else />
      <PresetResetButton
        :reset="resetSpeechSettings"
        :label="languages.AUDIO_RESET_SPEECH_DEFAULTS"
      />
    </template>
  </SettingsTabLayout>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { AUDIO_CATEGORY, usePresets } from '@/assets/js/store/presets'
import PresetResetButton from '@/components/PresetResetButton.vue'
import PresetSelector from '@/components/PresetSelector.vue'
import SettingsStt from '@/components/SettingsStt.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import SettingsTtsInferencing from '@/components/SettingsTtsInferencing.vue'
import { useActiveAudioPreset, useSpeechSettingsReset } from '@/assets/js/activeAudioPreset'
import { usePresetPicker } from '@/assets/js/presetPicker'

const languages = useI18N().state
const presetsStore = usePresets()
const { isTtsPreset, isSttPreset } = useActiveAudioPreset()
const { resetSpeechSettings } = useSpeechSettingsReset()
const { changePreset, changeVariant } = usePresetPicker({ skipModeSwitch: true })
</script>
