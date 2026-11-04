<template>
  <!-- The speech engines are global (ADR-0004), so the whole tab applies to all sessions. -->
  <SettingsTabLayout machine-only>
    <template #picker>
      <PresetSelector
        type="chat"
        :categories="[AUDIO_CATEGORY]"
        :model-value="presetsStore.activePresetName || undefined"
        @update:model-value="handlePresetChange"
        @update:variant="handleVariantChange"
      />
    </template>

    <SettingsTtsInferencing v-if="isTtsPreset" />
    <SettingsStt v-else-if="isSttPreset" />

    <template v-if="isTtsPreset || isSttPreset" #reset-fallback>
      <AudioPresetResetButton />
    </template>
  </SettingsTabLayout>
</template>

<script setup lang="ts">
import { AUDIO_CATEGORY, usePresets } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import AudioPresetResetButton from '@/components/AudioPresetResetButton.vue'
import PresetSelector from '@/components/PresetSelector.vue'
import SettingsStt from '@/components/SettingsStt.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import SettingsTtsInferencing from '@/components/SettingsTtsInferencing.vue'
import { useActiveAudioPreset } from '@/assets/js/activeAudioPreset'
import * as toast from '@/assets/js/toast'

const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const { isTtsPreset, isSttPreset } = useActiveAudioPreset()

async function handlePresetChange(presetName: string) {
  const result = await presetSwitching.switchPreset(presetName, { skipModeSwitch: true })
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
