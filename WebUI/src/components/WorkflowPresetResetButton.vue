<template>
  <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
    <button class="mt-4" @click="imageGeneration.resetActivePresetSettings">
      <div class="svg-icon i-refresh">Reset</div>
      {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'

const languages = useI18N().state
const imageGeneration = useImageGenerationPresets()
</script>
