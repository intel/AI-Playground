<template>
  <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
    <button class="mt-4" @click="textInference.resetActivePresetSettings">
      <div class="svg-icon i-refresh">Reset</div>
      {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { useTextInference } from '@/assets/js/store/textInference'

const languages = useI18N().state
const textInference = useTextInference()
</script>
