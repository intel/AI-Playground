<template>
  <div id="prompt-area" class="text-white flex flex-col w-full py-4">
    <div class="flex flex-col items-center gap-7 text-base px-4">
      <p class="text-2xl font-bold">
        Let's Generate
      </p>
      <div class="relative w-full max-w-3xl">
        <textarea
          class="rounded-2xl resize-none w-full h-48 pb-16"
          :placeholder="getTextAreaPlaceholder()"
          v-model="question"
          @keydown="fastGenerate"
        ></textarea>
        <div class="absolute bottom-3 left-3 flex gap-2">
          <button
            v-for="mode in ['chat', 'imageGen', 'imageEdit', 'video'] as ModeType[]"
            :key="mode"
            @click="emits('selectMode', mode as ModeType)"
            :class="currentMode === mode ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600'"
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
            {{ mapModeToLabel(currentMode) }} Settings
          </button>
          <button
            @click="handleSubmitPromptClick"
            class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm">
            →
          </button>
        </div>
      </div>
    </div>
    <SideModalSpecificSettings
      :isVisible="showSettings"
      :mode="currentMode"
      @close="showSettings=false" />
  </div>
</template>

<script setup lang="ts">
import { getCurrentInstance, ref } from 'vue'
import SideModalSpecificSettings from "@/components/SideModalSpecificSettings.vue";
import { mapModeToLabel } from "@/lib/utils.ts";

const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const question = ref('')
const showSettings = ref(false)

const props = defineProps<{
  currentMode: ModeType
}>()

const emits = defineEmits<{
  (e: 'selectMode', value: ModeType): void,
  (e: 'submitPrompt', prompt: string, mode: ModeType): void
}>()

// todo: New abbreviations are likely wrong
// todo: Languages other than en-US need to be added
function getTextAreaPlaceholder() {
  switch (props.currentMode) {
    case 'chat':
      return languages?.COM_LLM_PROMPT || ''
    case 'imageGen':
      return languages?.COM_SD_PROMPT || ''
    case 'imageEdit':
      return languages?.COM_SD_ENHANCE_PROMPT || ''
    case 'video':
      return languages?.COM_VIDEO_PROMPT || ''
    default:
      return languages?.COM_LLM_PROMPT || ''
  }
}

function handleSubmitPromptClick() {
  emits('submitPrompt', question.value, props.currentMode)
  question.value = ''
}

function fastGenerate(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSubmitPromptClick()
  }
}
</script>

<!-- todo: showDownloadModelConfirm needs to be handled or re-emited-->
<!-- todo: showModelRequest needs to be handled or re-emited-->
