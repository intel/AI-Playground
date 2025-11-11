<template>
  <div id="prompt-area" class="text-white flex flex-col w-full pt-4">
    <div class="flex flex-col items-center gap-7 text-base px-4">
        <div v-if="contextError" class="flex items-center gap-3">
          <p class="text-red-500">{{ contextError }}</p>
        </div>
      <div class="flex items-center gap-3">
        <p class="text-2xl font-bold">Let's Generate</p>
        <Context
          v-if="promptStore.getCurrentMode() === 'chat'"
          :used-tokens="contextUsedTokens"
          :max-tokens="contextMaxTokens"
          :usage="contextUsage"
        >
          <ContextTrigger />
          <ContextContent>
            <ContextContentHeader />
            <ContextContentBody />
          </ContextContent>
        </Context>
      </div>
      <div class="relative w-full max-w-3xl">
        <!-- RAG Documents Display (only in chat mode) -->
        <div
          v-if="promptStore.getCurrentMode() === 'chat' && checkedRagDocuments.length > 0"
          class="text-xs relative top-11 z-5 -left-1 -mt-11 mx-2 mb-3 flex flex-wrap items-center gap-2 px-1 py-1 "
        >
          <span class=" text-gray-400 flex items-center gap-1">
            <PaperClipIcon class="size-4" />
          </span>
          <div
            v-for="doc in checkedRagDocuments"
            :key="doc.hash"
            class="flex items-center gap-1 px-1 py-0.5 bg-purple-600/20 border border-purple-500/30 rounded-md text-gray-200 hover:bg-purple-600/30 transition-colors group"
          >
            <span class="svg-icon flex-none w-4 h-4" :class="getRagIconClass(doc.type)"></span>
            <span class="truncate max-w-[200px]" :title="doc.filename">{{ doc.filename }}</span>
            <button
              @click="textInference.updateFileCheckStatus(doc.hash, false)"
              class="ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-red-400"
              title="Remove from context"
            >
              <XMarkIcon class="size-4" />
            </button>
          </div>
        </div>
        <textarea
          class="rounded-2xl resize-none w-full h-48 px-4 pb-16"
          :class="{ [`pt-${checkedRagDocuments.length > 0 && promptStore.getCurrentMode() === 'chat' ? 8 : 3}`]: true }"
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
import { useImageGenerationPresets } from "@/assets/js/store/imageGenerationPresets.ts";
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useTextInference, type ValidFileExtension } from '@/assets/js/store/textInference'
import { PlusIcon, PaperClipIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import {Input} from '@/components/ui/input'
import {Label} from '@/components/ui/label'
import {
  Context,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
} from '@/components/ui/context'

const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const prompt = ref('')
const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const processingDebounceTimer = ref<number | null>(null)
const openAiCompatibleChat = useOpenAiCompatibleChat()
const textInference = useTextInference()

// Get checked RAG documents for display
const checkedRagDocuments = computed(() => {
  return textInference.ragList.filter((doc) => doc.isChecked)
})

// Get icon class for RAG document type
function getRagIconClass(type: ValidFileExtension): string {
  switch (type) {
    case 'doc':
    case 'docx':
      return 'i-word'
    case 'md':
      return 'i-md'
    case 'pdf':
      return 'i-pdf'
    case 'txt':
    default:
      return 'i-txt'
  }
}

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

// Context usage data for Context component
const contextUsedTokens = computed(() => openAiCompatibleChat.usedTokens)
const contextMaxTokens = computed(() => textInference.contextSize)
const contextUsage = computed(() => openAiCompatibleChat.contextUsage)
const contextError = computed(() => openAiCompatibleChat.error)

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
