<template>
  <div id="prompt-area" class="text-white flex flex-col w-full pt-4">
    <div class="flex flex-col items-center gap-7 text-base px-4">
      <p class="text-2xl font-bold">Let's Generate</p>
      <div class="relative w-full max-w-3xl">
        <textarea
          class="rounded-2xl resize-none w-full h-48 pb-16"
          :placeholder="getTextAreaPlaceholder()"
          v-model="prompt"
          @keydown="fastGenerate"
        ></textarea>
        <div class="absolute bottom-3 left-3 flex gap-2">
          <button
            v-for="mode in ['chat', 'imageGen', 'imageEdit', 'video'] as ModeType[]"
            :key="mode"
            @click="promptStore.setMode(mode)"
            :class="
              promptStore.currentMode === mode
                ? 'bg-blue-600 hover:bg-blue-500'
                : 'bg-gray-700 hover:bg-gray-600'
            "
            class="px-3 py-1.5 rounded-lg text-sm"
          >
            {{ mapModeToLabel(mode) }}
          </button>
        </div>
        <div class="absolute bottom-3 right-3 flex gap-2">
          <button
            class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm"
            @click="$emit('openSettings')"
          >
            {{ mapModeToLabel(promptStore.currentMode) }} Settings
          </button>
          <button
            v-if="!isProcessing"
            @click="handleSubmitPromptClick"
            class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm min-w-[44px]"
          >
            →
          </button>
          <button
            v-if="isProcessing && !isStopping"
            @click="handleCancelClick"
            class="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-sm min-w-[44px] flex items-center justify-center"
          >
            <i class="svg-icon w-4 h-4 i-stop"></i>
          </button>
          <button
            v-if="isProcessing && isStopping"
            disabled
            class="px-3 py-1.5 bg-red-400 cursor-not-allowed rounded-lg text-sm min-w-[44px] flex items-center justify-center"
          >
            <i class="svg-icon w-4 h-4 i-loading"></i>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getCurrentInstance, ref, computed } from 'vue'
import { mapModeToLabel } from '@/lib/utils.ts'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useImageGeneration } from "@/assets/js/store/imageGeneration.ts";

const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const prompt = ref('')
const promptStore = usePromptStore()
const imageGeneration = useImageGeneration()

const emits = defineEmits<{
  (e: 'autoHideFooter'): void,
  (e: 'openSettings'): void
}>()

const isProcessing = computed(() =>
  promptStore.processing || imageGeneration.processing
)

const isStopping = computed(() =>
  imageGeneration.stopping
)


function getTextAreaPlaceholder() {
  switch (promptStore.currentMode) {
    case 'chat':
      return languages?.COM_PROMPT_CHAT || ''
    case 'imageGen':
      return languages?.COM_PROMPT_IMAGE_GEN || ''
    case 'imageEdit':
      return languages?.COM_PROMPT_IMAGE_EDIT || ''
    case 'video':
      return languages?.COM_PROMPT_VIDEO || ''
    default:
      return languages?.COM_PROMPT_CHAT || ''
  }
}

function handleSubmitPromptClick() {
  emits('autoHideFooter')
  promptStore.submitPrompt(prompt.value, promptStore.currentMode)
  prompt.value = ''
}

function handleCancelClick() {
  promptStore.cancelProcessing()
}

function fastGenerate(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSubmitPromptClick()
  }
}
</script>
