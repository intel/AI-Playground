<template>
  <div id="prompt-area" class="text-foreground flex flex-col w-full pt-4">
    <div class="flex flex-col items-center gap-7 text-base px-4">
        <div v-if="contextError" class="flex items-center gap-3">
          <p class="text-red-500">{{ contextError }}</p>
        </div>
      <div class="grid grid-cols-3 items-center gap-3 h-10">
        <p class="text-2xl col-start-2 font-bold">Let's Generate</p>
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
          <span class=" text-muted-foreground flex items-center gap-1">
            <PaperClipIcon class="size-4" />
          </span>
          <div
            v-for="doc in checkedRagDocuments"
            :key="doc.hash"
            class="flex items-center gap-1 px-1 py-0.5 bg-primary/20 border border-primary/30 rounded-md text-foreground hover:bg-primary/30 transition-colors group"
          >
            <span class="svg-icon flex-none w-4 h-4" :class="getRagIconClass(doc.type)"></span>
            <span class="truncate max-w-[200px]" :title="doc.filename">{{ doc.filename }}</span>
            <button
              @click="textInference.updateFileCheckStatus(doc.hash, false)"
              class="ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
              title="Remove from context"
            >
              <XMarkIcon class="size-4" />
            </button>
          </div>
        </div>
        <textarea
          class="resize-none w-full h-48 px-4 pb-16 bg-background/50 rounded-md outline-none border border-border focus-visible:ring-[1px] focus-visible:ring-primary"
          :class="{
            [`pt-${checkedRagDocuments.length > 0 && promptStore.getCurrentMode() === 'chat' ? 8 : 3}`]: true,
            'opacity-50 cursor-not-allowed': !isPromptModifiable
          }"
          :placeholder="getTextAreaPlaceholder()"
          v-model="prompt"
          :disabled="isTextAreaDisabled"
          @keydown="fastGenerate"
        ></textarea>
        <div class="absolute bottom-14 left-3 flex gap-2">
          <img
            v-for="preview in imagePreview"
            :key="preview.id"
            :src="preview.url"
            alt="Image Preview"
            class="max-h-12 max-w-12 mr-2 aspect-square object-contain border border-dashed border-border rounded-md"
          />
          <!-- TODO: delete icon for loaded images -->
          <div
            ref="dropZoneRef"
            class="self-center border border-dashed border-border rounded-md p-1 hover:cursor-pointer"
            :class="{ 'border-primary bg-primary/10': isOverDropZone }"
          >
            <Label htmlFor="file-attachment"><PlusIcon class="size-4 cursor-pointer" /></Label>
            <Input
              type="file"
              class="hidden"
              id="file-attachment"
              :accept="promptStore.getCurrentMode() === 'chat' ? 'image/*,.txt,.doc,.docx,.md,.pdf' : 'image/*'"
              multiple
              @change="handleFileInput"
            />
          </div>
        </div>
        <div class="absolute bottom-4 left-3 flex gap-2">
          <button
            v-for="mode in ['chat', 'imageGen', 'imageEdit', 'video'] as ModeType[]"
            :key="mode"
            @click="promptStore.setCurrentMode(mode)"
            :class="
              promptStore.getCurrentMode() === mode
                ? 'bg-primary hover:bg-primary/80'
                : 'bg-muted hover:bg-muted/80'
            "
            class="px-3 py-1.5 rounded-lg text-sm"
          >
            {{ mapModeToLabel(mode) }}
          </button>
        </div>
        <div class="absolute bottom-4 right-3 flex gap-2">
          <button
            v-if="promptStore.getCurrentMode() === 'chat'"
            @click="handleRecordingClick"
            :disabled="audioRecorder.isTranscribing"
            :class="{
              'bg-red-500 hover:bg-red-600 animate-pulse': audioRecorder.isRecording,
              'bg-muted hover:bg-muted/80': !audioRecorder.isRecording,
              'opacity-50 cursor-not-allowed': audioRecorder.isTranscribing
            }"
            class="px-3 py-1.5 text-foreground rounded-lg text-sm flex items-center justify-center transition-colors"
            :title="audioRecorder.isRecording ? 'Stop recording' : audioRecorder.isTranscribing ? 'Transcribing...' : 'Voice recording'"
          >
            <i
              v-if="!audioRecorder.isTranscribing"
              class="svg-icon w-4 h-4"
              :class="audioRecorder.isRecording ? 'i-stop' : 'i-record'"
            ></i>
            <i
              v-else
              class="svg-icon w-4 h-4 i-loading animate-spin"
            ></i>
          </button>
          <button
            class="px-3 py-1.5 bg-muted hover:bg-muted/80 text-foreground rounded-lg text-sm"
            @click="$emit('openSettings')"
          >
            {{ mapModeToLabel(promptStore.getCurrentMode()) }} Settings
          </button>
          <button
            v-if="readyForNewSubmit"
            @click="handleSubmitPromptClick"
            class="px-3 py-1.5 bg-primary hover:bg-primary/80 rounded-lg text-sm min-w-[44px]"
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
import { useAudioRecorder } from "../assets/js/store/audioRecorder";
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useImageGenerationPresets } from "@/assets/js/store/imageGenerationPresets.ts";
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useTextInference, type ValidFileExtension, type IndexedDocument } from '@/assets/js/store/textInference'
import { useI18N } from '@/assets/js/store/i18n'
import { PlusIcon, PaperClipIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import {Input} from '@/components/ui/input'
import {Label} from '@/components/ui/label'
import { useDropZone } from '@vueuse/core'
import * as toast from '@/assets/js/toast'
import {
  Context,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
} from '@/components/ui/context'

const instance = getCurrentInstance()
const audioRecorder = useAudioRecorder()
const languages = instance?.appContext.config.globalProperties.languages
const i18nState = useI18N().state
const prompt = ref('')
const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const processingDebounceTimer = ref<number | null>(null)
const openAiCompatibleChat = useOpenAiCompatibleChat()
const textInference = useTextInference()
const dropZoneRef = ref<HTMLDivElement>()

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

// Check if prompt is modifiable for ComfyUI presets
const isPromptModifiable = computed(() => {
  const mode = promptStore.getCurrentMode()
  // For chat mode, prompt is always modifiable
  if (mode === 'chat') return true

  // For image/video modes, check if there's an active ComfyUI preset
  if (mode === 'imageGen' || mode === 'imageEdit' || mode === 'video') {
    // If there's an active preset, check if prompt is modifiable
    if (imageGeneration.activePreset) {
      return imageGeneration.isModifiable('prompt')
    }
    // If no active preset, allow prompt input (fallback behavior)
    return true
  }

  return true
})

const isTextAreaDisabled = computed(() => {
  return !readyForNewSubmit.value || !isPromptModifiable.value
})

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

async function handleRecordingClick() {
  if (audioRecorder.isRecording) {
    audioRecorder.stopRecording()

    await new Promise(resolve => setTimeout(resolve, 100))

    if (audioRecorder.audioBlob) {
      audioRecorder.transcribeAudio()
    }
  } else {
    await audioRecorder.startRecording()

    if (audioRecorder.error) {
      toast.error(audioRecorder.error)
    }
  }
}

function fastGenerate(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSubmitPromptClick()
  }
}

// Valid document extensions for RAG
const validDocumentExtensions = ['txt', 'doc', 'docx', 'md', 'pdf'] as const

// Check if a file is an image
function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

// Check if a file is a valid document
function isDocumentFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase()
  return ext ? validDocumentExtensions.includes(ext as ValidFileExtension) : false
}

// Handle file input change
async function handleFileInput(event: Event) {
  const target = event.target as HTMLInputElement
  if (!target.files || target.files.length === 0) return

  const files = Array.from(target.files)
  const imageFiles: File[] = []
  const documentFiles: File[] = []

  // Separate images from documents
  for (const file of files) {
    if (isImageFile(file)) {
      imageFiles.push(file)
    } else if (isDocumentFile(file) && promptStore.getCurrentMode() === 'chat') {
      documentFiles.push(file)
    }
  }

  // Handle images (existing behavior)
  if (imageFiles.length > 0) {
    const imageFileList = new DataTransfer()
    imageFiles.forEach(file => imageFileList.items.add(file))
    openAiCompatibleChat.fileInput = imageFileList.files
  }

  // Handle documents (add to RAG)
  if (documentFiles.length > 0) {
    await addDocumentsToRagList(documentFiles)
  }

  // Reset input
  target.value = ''
}

// Add documents to RAG list
async function addDocumentsToRagList(files: File[]) {
  for (const file of files) {
    try {
      const filePath = window.electronAPI.getFilePath(file)
      const name = filePath.split(/(\\|\/)/g).pop()
      const ext = name?.split('.').pop()?.toLowerCase() as ValidFileExtension | undefined

      if (!name || !ext || !validDocumentExtensions.includes(ext)) {
        toast.error(i18nState.RAG_UPLOAD_TYPE_ERROR)
        continue
      }

      // Check if document already exists in RAG list (by filepath)
      const existingDoc = textInference.ragList.find((doc) => doc.filepath === filePath)

      if (existingDoc) {
        // Document already exists - just enable it if it's disabled
        if (!existingDoc.isChecked) {
          textInference.updateFileCheckStatus(existingDoc.hash, true)
        }
        // If already checked, do nothing
        continue
      }

      // Document doesn't exist - add it
      const newDocument: IndexedDocument = {
        filename: name,
        filepath: filePath,
        type: ext,
        splitDB: [],
        hash: '',
        isChecked: true,
      }

      await textInference.addDocumentToRagList(newDocument)
    } catch (error) {
      console.error('Error adding document to RAG list:', error)
      toast.error(i18nState.RAG_UPLOAD_TYPE_ERROR)
    }
  }
}

// Handle drag and drop
function onDrop(files: File[] | null) {
  if (!files || files.length === 0) return

  const imageFiles: File[] = []
  const documentFiles: File[] = []

  // Separate images from documents
  for (const file of files) {
    if (isImageFile(file)) {
      imageFiles.push(file)
    } else if (isDocumentFile(file) && promptStore.getCurrentMode() === 'chat') {
      documentFiles.push(file)
    }
  }

  // Handle images
  if (imageFiles.length > 0) {
    const imageFileList = new DataTransfer()
    imageFiles.forEach(file => imageFileList.items.add(file))
    openAiCompatibleChat.fileInput = imageFileList.files
  }

  // Handle documents
  if (documentFiles.length > 0) {
    // Validate document extensions
    const filePaths = documentFiles.map((file) => window.electronAPI.getFilePath(file))
    const fileExtensions = filePaths.map((filePath) => filePath.split('.').pop()?.toLowerCase() ?? '')

    if (fileExtensions.some((ext) => !validDocumentExtensions.includes(ext as ValidFileExtension))) {
      toast.error(i18nState.RAG_UPLOAD_TYPE_ERROR)
      return
    }

    addDocumentsToRagList(documentFiles)
  }
}

// Set up drag and drop zone
const { isOverDropZone } = useDropZone(dropZoneRef, {
  onDrop,
  multiple: true,
  preventDefaultForUnhandled: false,
})
</script>
