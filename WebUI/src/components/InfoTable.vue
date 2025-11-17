<template>
  <div
    v-if="props.generationParameters"
    class="info-params absolute px-5 pt-8 pb-5 text-foreground w-1000"
  >
    <button
      class="w-5 h-5 svg-icon i-close absolute right-2 top-2 text-foreground hover:text-foreground/80"
      @click="emits('close')"
    ></button>
    <div class="params-list">
      <ul class="border border-border">
        <li
          v-for="(value, key) in props.generationParameters"
          class="last:border-none border-b border-border flex items-center"
          :key="key"
        >
          <span class="text-base font-bold px-4 items-stretch w-36 flex-none">{{
            languages[settingToTranslationKey[key]] ?? key
          }}</span>
          <span class="px-4 flex-auto break-word">{{ value }}</span>
        </li>
      </ul>
      <ul class="border border-border">
        <li
          v-for="value in props.dynamicInputs"
          class="last:border-none border-b border-border flex items-center"
          :key="value.label"
        >
          <span class="text-base font-bold px-4 items-stretch w-36 flex-none">{{
            languages[getTranslationLabel('SETTINGS_IMAGE_COMFY_', value.label)] ?? value.label
          }}</span>
          <img v-if="value.type === 'image'" :src="value.current" class="info-params-image" />
          <span v-else class="px-4 flex-auto break-word">{{ value.current }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ComfyDynamicInputWithCurrent, GenerationSettings } from '@/assets/js/store/imageGeneration'
import { getTranslationLabel } from '@/lib/utils'

const props = defineProps<{
  generationParameters: GenerationSettings
  dynamicInputs?: ComfyDynamicInputWithCurrent[]
}>()

const settingToTranslationKey: Record<keyof GenerationSettings, string> = {
  workflow: 'SETTINGS_IMAGE_WORKFLOW',
  device: 'DEVICE',
  imageModel: 'DOWNLOADER_MODEL',
  inpaintModel: 'DOWNLOADER_FOR_INAPINT_GENERATE',
  negativePrompt: 'SETTINGS_MODEL_NEGATIVE_PROMPT',
  resolution: 'SETTINGS_MODEL_IMAGE_RESOLUTION',
  prompt: 'INPUT_PROMPT',
  guidanceScale: 'SETTINGS_MODEL_IMAGE_CFG',
  inferenceSteps: 'SETTINGS_MODEL_IMAGE_STEPS',
  seed: 'SETTINGS_MODEL_SEED',
  lora: 'SETTINGS_MODEL_LORA',
  scheduler: 'SETTINGS_MODEL_SCHEDULER',
  imagePreview: 'SETTINGS_MODEL_IMAGE_PREVIEW',
  safetyCheck: 'SETTINGS_MODEL_SAFE_CHECK',
  batchSize: 'SETTINGS_MODEL_GENERATE_NUMBER',
  width: 'SETTINGS_MODEL_IMAGE_WIDTH',
  height: 'SETTINGS_MODEL_IMAGE_HEIGHT',
}

const emits = defineEmits<{
  (e: 'close'): void
}>()
</script>
