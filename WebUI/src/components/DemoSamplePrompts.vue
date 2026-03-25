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
        Apply ›
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

const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const demoMode = useDemoMode()
const presetsStore = usePresets()

const FALLBACK_SAMPLES: SamplePrompt[] = [
  {
    title: 'Prompt Example',
    description: 'Ask a science question and get an answer:',
    prompt: 'Why does water expand when it freezes?',
    mode: 'chat',
  },
  {
    title: 'Image Generation Example',
    description: 'Create a fantastic image from a detailed prompt:',
    prompt:
      'A close-up photo of a hummingbird hovering to get nectar from a red rose with drops of dew. Iridescent blue and green feathers, wings a blur. Depth of field. High Dynamic Range.',
    mode: 'imageGen',
  },
  {
    title: 'Image Editing Example',
    description: 'Edit a photo by describing what to change. An image is already given:',
    prompt: 'Remove people from the background',
    mode: 'imageEdit',
  },
  {
    title: 'Sketch to Photo Example',
    description: 'Turn a sketch into a photo by describing the scene:',
    prompt: 'Photo of a modern apartment building, tropical resort, sunset view',
    mode: 'imageEdit',
    presetName: 'Sketch to Photo',
  },
  {
    title: 'Video Generation Example',
    description: 'Create a short video from a text description.',
    prompt: 'A golden retriever running through a field of sunflowers on a sunny day',
    mode: 'video',
  },
]

const samples = computed(() => demoMode.profile?.samplePrompts ?? FALLBACK_SAMPLES)
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
