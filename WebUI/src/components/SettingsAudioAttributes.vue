<template>
  <SettingsTabLayout v-if="isTtsPreset">
    <template #machine>
      <SettingsTtsAttributes />
      <PresetResetButton
        :reset="resetSpeechSettings"
        :label="languages.AUDIO_RESET_SPEECH_DEFAULTS"
      />
    </template>
  </SettingsTabLayout>
  <div v-else-if="isSttPreset" class="p-4 w-full max-w-3xl mx-auto">
    <p class="text-sm text-muted-foreground">{{ languages.AUDIO_STT_NO_ATTRIBUTES }}</p>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import PresetResetButton from '@/components/PresetResetButton.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import SettingsTtsAttributes from '@/components/SettingsTtsAttributes.vue'
import { useActiveAudioPreset, useSpeechSettingsReset } from '@/assets/js/activeAudioPreset'

const languages = useI18N().state
const { isTtsPreset, isSttPreset } = useActiveAudioPreset()
const { resetSpeechSettings } = useSpeechSettingsReset()
</script>
