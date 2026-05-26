<template>
  <div
    v-if="activeSample"
    class="flex w-full flex-col gap-1 text-left z-[var(--demo-z-sample)] driver-active-element"
    @mousedown.prevent
  >
    <div class="demo-sample-body" @click="applySample(activeSample)">
      <span class="demo-sample-title">{{ activeSample.title }}</span>
      <span class="demo-sample-description">{{ activeSample.description }}</span>
      <span class="demo-sample-prompt">"{{ activeSample.prompt }}"</span>
      <button
        class="demo-sample-apply-btn z-[var(--demo-z-sample-btn)]"
        type="button"
        @click="applySample(activeSample)"
      >
        {{ i18nState.COM_APPLY_ACTION }} ›
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { populateImageEditHistory } from '@/assets/js/store/demoModeDefaults'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { usePresets } from '@/assets/js/store/presets'
import { useI18N } from '@/assets/js/store/i18n'

const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const demoMode = useDemoMode()
const presetsStore = usePresets()
const i18nState = useI18N().state

const FALLBACK_SAMPLES = computed<SamplePrompt[]>(() => [
  {
    title: i18nState.SAMPLE_CHAT_TITLE,
    description: i18nState.SAMPLE_CHAT_DESC,
    prompt: i18nState.SAMPLE_CHAT_PROMPT,
    mode: 'chat',
  },
  {
    title: i18nState.SAMPLE_IMAGE_GEN_TITLE,
    description: i18nState.SAMPLE_IMAGE_GEN_DESC,
    prompt: i18nState.SAMPLE_IMAGE_GEN_PROMPT,
    mode: 'imageGen',
  },
  {
    title: i18nState.SAMPLE_IMAGE_EDIT_TITLE,
    description: i18nState.SAMPLE_IMAGE_EDIT_DESC,
    prompt: i18nState.SAMPLE_IMAGE_EDIT_PROMPT,
    mode: 'imageEdit',
  },
  {
    title: i18nState.SAMPLE_SKETCH_TITLE,
    description: i18nState.SAMPLE_SKETCH_DESC,
    prompt: i18nState.SAMPLE_SKETCH_PROMPT,
    mode: 'imageEdit',
    presetName: 'Sketch to Photo',
  },
  {
    title: i18nState.SAMPLE_VIDEO_TITLE,
    description: i18nState.SAMPLE_VIDEO_DESC,
    prompt: i18nState.SAMPLE_VIDEO_PROMPT,
    mode: 'video',
  },
])

const samples = computed(() => demoMode.profile?.samplePrompts ?? FALLBACK_SAMPLES.value)
const activeSample = computed(() => {
  const mode = promptStore.currentMode
  const presetName = presetsStore.activePreset?.name
  const presetMatch = samples.value.find((s) => s.mode === mode && s.presetName === presetName)
  if (presetMatch) return presetMatch
  return samples.value.find((s) => s.mode === mode && !s.presetName)
})

function applySample(sample: SamplePrompt) {
  if (sample.mode === 'imageEdit') {
    void populateImageEditHistory(imageGeneration, sample.presetName)
  }
  promptStore.injectPromptText(sample.prompt)
  document.getElementById('prompt-input')?.focus()
}
</script>

<style scoped>
.demo-sample-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  cursor: pointer;
  font-family: 'IntelOne', sans-serif;
  max-width: 220px;
  width: 100%;
}

.demo-sample-title {
  font-size: 0.875rem;
  font-weight: bold;
  color: var(--demo-title-color);
}

.demo-sample-description {
  font-size: 0.75rem;
  color: hsl(var(--muted-foreground));
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.demo-sample-prompt {
  font-size: 0.75rem;
  color: hsl(var(--muted-foreground));
  font-style: italic;
  margin-top: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.demo-sample-apply-btn {
  align-self: flex-end;
  margin-top: 4px;
  padding: 2px 10px;
  background: transparent;
  border: 1.5px solid var(--demo-accent);
  border-radius: 6px;
  color: var(--demo-accent);
  font-family: 'IntelOne', sans-serif;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.2s ease,
    color 0.2s ease;
}

.demo-sample-apply-btn:hover {
  background: var(--demo-accent);
  color: var(--demo-popover-bg);
}
</style>
