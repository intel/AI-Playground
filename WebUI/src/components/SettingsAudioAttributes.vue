<template>
  <SettingsTabLayout v-if="isTtsPreset" machine-only>
    <SettingsTtsAttributes />
    <template #reset-fallback>
      <AudioPresetResetButton />
    </template>
  </SettingsTabLayout>
  <div v-else-if="isSttPreset" class="p-4 w-full max-w-3xl mx-auto">
    <p class="text-sm text-muted-foreground">{{ languages.AUDIO_STT_NO_ATTRIBUTES }}</p>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import AudioPresetResetButton from '@/components/AudioPresetResetButton.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import SettingsTtsAttributes from '@/components/SettingsTtsAttributes.vue'
import { useActiveAudioPreset } from '@/assets/js/activeAudioPreset'

const languages = useI18N().state
const { isTtsPreset, isSttPreset } = useActiveAudioPreset()
</script>
