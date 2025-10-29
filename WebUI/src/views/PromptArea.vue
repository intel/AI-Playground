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
            @click="showSettings = true"
          >
            {{ mapModeToLabel(promptStore.currentMode) }} Settings
          </button>
          <button
            v-if="!promptStore.processing"
            @click="handleSubmitPromptClick"
            class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm"
          >
            →
          </button>
          <button
            v-else
            @click="handleCancelClick"
            class="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-sm"
          >
            ⏹
          </button>
        </div>
      </div>
    </div>
    <SideModalSpecificSettings
      :isVisible="showSettings"
      :mode="promptStore.currentMode"
      @close="showSettings = false"
    />
  </div>
</template>

<script setup lang="ts">
import { getCurrentInstance, ref } from 'vue'
import SideModalSpecificSettings from '@/components/SideModalSpecificSettings.vue'
import { mapModeToLabel } from '@/lib/utils.ts'
import { usePromptStore } from '@/assets/js/store/promptArea'

const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const prompt = ref('')
const showSettings = ref(false)
const promptStore = usePromptStore()

const emits = defineEmits<{
  (e: 'autoHideFooter'): void
}>()

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
