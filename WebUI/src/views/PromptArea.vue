<template>
  <div id="prompt-area" class="text-white flex flex-col w-full pt-4">
    <div class="flex flex-col items-center gap-7 text-base px-4">
      <p class="text-2xl font-bold">Let's Generate</p>
      <div class="relative w-full max-w-3xl">
        <textarea
          class="rounded-2xl resize-none w-full h-48 pb-16"
          :placeholder="getTextAreaPlaceholder()"
          v-model="prompt"
          :disabled="!readyForNewSubmit"
          @keydown="fastGenerate"
        ></textarea>
        <div class="absolute bottom-14 left-3 flex gap-2">
          <img
            v-for="preview in imagePreview"
            :key="preview.id"
            :src="preview.url"
            alt="Image Preview"
            class="max-h-12 max-w-12 mr-2 aspect-square object-contain border border-dashed border-gray-500 rounded-md"
          />
          <!-- TODO: delete icon for loaded images -->
          <div class="self-center border border-dashed border-gray-500 rounded-md p-1 hover:cursor-pointer">
            <Label htmlFor="image"><PlusIcon class="size-4 cursor-pointer" /></Label>
            <Input
              type="file"
              class="hidden"
              id="image"
              @change="openAiCompatibleChat.fileInput = $event.target.files"
            />
          </div>
        </div>
        <div class="absolute bottom-3 left-3 flex gap-2">
          <button
            v-for="mode in ['chat', 'imageGen', 'imageEdit', 'video'] as ModeType[]"
            :key="mode"
            @click="promptStore.setCurrentMode(mode)"
            :class="
              promptStore.getCurrentMode() === mode
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
            {{ mapModeToLabel(promptStore.getCurrentMode()) }} Settings
          </button>
          <button
            v-if="readyForNewSubmit"
            @click="handleSubmitPromptClick"
            class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm min-w-[44px]"
          >
            →
          </button>
          <button
            v-else-if="!isStopping"
            @click="handleCancelClick"
            class="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-sm min-w-[44px] flex items-center justify-center"
          >
            <i class="svg-icon w-4 h-4 i-stop"></i>
          </button>
          <button
            v-else
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
import { getCurrentInstance, ref, computed, watch } from 'vue'
import { mapModeToLabel } from '@/lib/utils.ts'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useImageGeneration } from "@/assets/js/store/imageGeneration.ts";
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { PlusIcon } from '@heroicons/vue/24/outline'
import {Input} from '@/components/ui/input'
import {Label} from '@/components/ui/label'

const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const prompt = ref('')
const promptStore = usePromptStore()
const imageGeneration = useImageGeneration()
const processingDebounceTimer = ref<number | null>(null)
const openAiCompatibleChat = useOpenAiCompatibleChat()

const emits = defineEmits<{
  (e: 'autoHideFooter'): void,
  (e: 'openSettings'): void
}>()

const imagePreview = computed(() => {
  if (openAiCompatibleChat.fileInput) {
    const urls = []
    let id = 0
    for (const file of openAiCompatibleChat.fileInput) {
      const url = URL.createObjectURL(file)
      urls.push({ id, url })
      id++
    }
    return urls
  }
  return []
})

const isProcessing = computed(() =>
  openAiCompatibleChat.processing || imageGeneration.processing
)

const isStopping = computed(() =>
  imageGeneration.stopping
)

const readyForNewSubmit = computed(() =>
  !promptStore.promptSubmitted && !isProcessing.value
)

watch(isProcessing, (newValue, oldValue) => {
  if (processingDebounceTimer.value !== null) {
    clearTimeout(processingDebounceTimer.value)
    processingDebounceTimer.value = null
  }

  if (oldValue === true && newValue === false) {
    processingDebounceTimer.value = window.setTimeout(() => {
      prompt.value = ''
      promptStore.promptSubmitted = false
      processingDebounceTimer.value = null
    }, 1000)
  }
})

function getTextAreaPlaceholder() {
  switch (promptStore.getCurrentMode()) {
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
  promptStore.submitPrompt(prompt.value)
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
