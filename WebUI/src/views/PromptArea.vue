<template>
  <div id="prompt-area" class="text-foreground flex flex-col w-full pt-4">
    <div class="group flex flex-col items-center gap-7 text-base px-4">
      <div v-if="contextError" class="flex items-center gap-3">
        <p class="text-red-500">{{ contextError }}</p>
      </div>
      <div class="grid grid-cols-3 items-center gap-3 h-10">
        <p class="text-2xl col-start-2 font-bold">Let's Generate</p>
        <Context
          v-if="promptStore.getCurrentMode() === 'chat'"
          :used-tokens="contextUsedTokens"
          :max-tokens="contextMaxTokens"
          :max-context-size="textInference.maxContextSizeFromModel"
          :usage="contextUsage"
        />
      </div>
      <div class="relative w-full max-w-3xl">
        <!-- Zoom Controls (only in chat mode) -->
        <div
          v-if="promptStore.getCurrentMode() === 'chat'"
          class="absolute -top-8 right-0 flex gap-1 z-[5]"
        >
          <button
            @click="textInference.decreaseFontSize()"
            :disabled="textInference.isMinSize"
            class="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Decrease font size"
          >
            <MagnifyingGlassMinusIcon class="size-5" />
          </button>
          <button
            @click="textInference.increaseFontSize()"
            :disabled="textInference.isMaxSize"
            class="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Increase font size"
          >
            <MagnifyingGlassPlusIcon class="size-5" />
          </button>
        </div>
        <!-- RAG Documents Display (only when RAG is enabled and has documents) -->
        <div
          v-if="
            promptStore.getCurrentMode() === 'chat' &&
            canAttachDocuments &&
            checkedRagDocuments.length > 0
          "
          class="text-xs relative top-11 z-5 -left-1 -mt-11 mx-2 mb-3 flex flex-wrap items-center gap-2 px-1 py-1"
        >
          <span class="text-muted-foreground flex items-center gap-1">
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
        <div class="relative w-full">
          <template v-if="demoMode.enabled && isFirstPrompt">
            <Popover :open="isTextareaFocused">
              <PopoverAnchor as-child>
                <div
                  class="pointer-events-none absolute left-3 -top-2 size-1 overflow-hidden opacity-0"
                  aria-hidden="true"
                />
              </PopoverAnchor>
              <PopoverContent
                side="top"
                align="start"
                :side-offset="10"
                class="z-[40010] w-auto min-w-0 rounded-xl border-[1.5px] border-[var(--demo-popover-border)] bg-[var(--demo-popover-bg)] p-3 text-[var(--demo-text-color)] shadow-[0px_0.75px_4.95px_var(--demo-popover-shadow)] dark:border-[var(--demo-popover-border)] dark:bg-[var(--demo-popover-bg)] dark:text-[var(--demo-text-color)]"
                @open-auto-focus.prevent
              >
                <div @mousedown.prevent @touchstart.prevent>
                  <DemoSamplePrompts />
                </div>
              </PopoverContent>
            </Popover>
          </template>
          <textarea
            id="prompt-input"
            ref="textareaRef"
            class="resize-none w-full h-48 px-4 pb-16 bg-background/50 rounded-md outline-none border border-border focus-visible:ring-[1px] focus-visible:ring-primary"
            :class="{
              [`pt-${checkedRagDocuments.length > 0 && canAttachDocuments && promptStore.getCurrentMode() === 'chat' ? 8 : 3}`]: true,
              'opacity-50 cursor-not-allowed text-transparent placeholder-transparent':
                !isPromptModifiable,
              'border-primary bg-primary/10': isOverDropZone,
            }"
            :placeholder="getTextAreaPlaceholder()"
            @focus="isTextareaFocused = true"
            @blur="isTextareaFocused = false"
            v-model="prompt"
            :disabled="isTextAreaDisabled"
            @keydown="fastGenerate"
          ></textarea>
          <div class="absolute bottom-14 left-3 flex gap-2">
            <div
              v-for="preview in imagePreview"
              :key="preview.id"
              class="relative max-h-12 max-w-12 mr-2 aspect-square group"
            >
              <img
                :src="preview.url"
                alt="Image Preview"
                class="w-full h-full object-contain border border-dashed border-border rounded-md"
              />
              <button
                @click="removeImage(preview.id)"
                class="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity bg-background rounded-full p-0.5 text-muted-foreground hover:text-destructive"
                title="Remove image"
              >
                <XMarkIcon class="size-4" />
              </button>
            </div>
            <div
              v-if="shouldShowImageUploadButton"
              class="self-center border border-dashed border-border rounded-md p-1 hover:cursor-pointer origin-bottom-left"
              :class="{ 'border-primary bg-primary/10': isOverDropZone }"
              id="plus-icon"
            >
              <Label htmlFor="file-attachment" @click="handlePlusIconClick">
                <PlusIcon class="size-4 cursor-pointer" />
              </Label>
              <input
                type="file"
                class="hidden"
                id="file-attachment"
                :accept="getAcceptedFileTypes()"
                multiple
                @change="handleFileInput"
              />
            </div>
          </div>
          <div id="mode-buttons" class="absolute bottom-4 left-3 flex gap-2">
            <Button
              v-for="mode in modesWithPresets"
              :variant="promptStore.getCurrentMode() === mode ? 'default' : 'secondary'"
              :key="mode"
              :id="'mode-button-' + mode"
              @click="handleModeClick(mode)"
            >
              {{ mapModeToLabel(mode) }}
            </Button>
          </div>
          <div class="absolute bottom-4 right-3 flex gap-2">
            <Button
              id="camera-button"
              class="bg-muted hover:bg-muted/80 text-foreground rounded-lg px-3 py-1.5"
              variant="secondary"
              v-if="promptStore.getCurrentMode() === 'chat'"
              @click="handleCameraClick"
              title="Capture image from camera"
            >
              <CameraIcon class="w-5 h-5" />
            </Button>
            <Button
              id="microphone-button"
              class="bg-muted hover:bg-muted/80 text-foreground rounded-lg px-3 py-1.5"
              variant="secondary"
              v-if="promptStore.getCurrentMode() === 'chat'"
              @click="handleRecordingClick"
              :disabled="(false && !speechToText.enabled) || audioRecorder.isTranscribing"
              :title="
                !speechToText.enabled ? 'Enable Speech To Text in settings to use voice input' : ''
              "
            >
              <i
                v-if="!audioRecorder.isTranscribing"
                class="svg-icon w-5 h-5"
                :class="audioRecorder.isRecording ? 'i-record-active' : 'i-record'"
              ></i>
              <div
                v-if="audioRecorder.isRecording"
                class="absolute -top-11 flex gap-1 items-end h-10"
              >
                <div
                  v-for="i in 5"
                  :key="i"
                  class="w-1.5 bg-primary rounded-full transition-all duration-100"
                  :style="{
                    height: `${Math.max(6, (audioRecorder.audioLevel / 100) * 40 * (i / 5))}px`,
                    opacity: audioRecorder.audioLevel > (i - 1) * 20 ? 1 : 0.35,
                  }"
                ></div>
              </div>
            </Button>
            <Button
              id="advanced-settings-button"
              class="px-3 py-1.5 bg-muted hover:bg-muted/80 text-foreground rounded-lg text-sm font-normal"
              @click="handleAdvancedSettingsClick"
            >
              {{ mapModeToLabel(promptStore.getCurrentMode()) }} Settings
            </Button>
            <Button
              v-if="readyForNewSubmit"
              @click="handleSubmitPromptClick"
              id="send-button"
              class="px-3 py-1.5 bg-primary hover:bg-primary/80 rounded-lg text-sm min-w-[44px]"
            >
              →
            </Button>
            <Button
              v-else-if="!isStopping"
              @click="handleCancelClick"
              class="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-sm min-w-[44px] flex items-center justify-center"
            >
              <i class="svg-icon w-4 h-4 i-stop"></i>
            </Button>
            <Button
              v-else
              disabled
              class="px-3 py-1.5 bg-red-400 cursor-not-allowed rounded-lg text-sm min-w-[44px] flex items-center justify-center"
            >
              <i class="svg-icon w-4 h-4 i-loading"></i>
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- Camera Capture Dialog -->
    <div
      v-if="dialogStore.cameraDialogVisible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div class="bg-background rounded-lg p-6 w-full max-w-lg mx-4 shadow-xl">
        <h2 class="text-lg font-semibold mb-4">Capture Image</h2>
        <CameraCapture @capture="dialogStore.handleCameraCapture" />
        <div class="mt-4 flex justify-end">
          <Button variant="outline" @click="dialogStore.closeCameraDialog()">Close</Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getCurrentInstance, ref, computed, watch, nextTick } from 'vue'
import type { FileUIPart } from 'ai'
import {
  mapModeToLabel,
  downscaleImageTo1MP,
  imageUrlToDataUri,
  saveImageToMediaInput,
} from '@/lib/utils.ts'
import { useAudioRecorder } from '@/assets/js/store/audioRecorder'
import { useSpeechToText } from '@/assets/js/store/speechToText'
import { usePromptStore } from '@/assets/js/store/promptArea'
import {
  useImageGenerationPresets,
  type ImageMediaItem,
} from '@/assets/js/store/imageGenerationPresets.ts'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import {
  useTextInference,
  type ValidFileExtension,
  type IndexedDocument,
} from '@/assets/js/store/textInference'
import { useI18N } from '@/assets/js/store/i18n'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets'
import {
  PlusIcon,
  PaperClipIcon,
  XMarkIcon,
  MagnifyingGlassPlusIcon,
  MagnifyingGlassMinusIcon,
} from '@heroicons/vue/24/outline'
import { CameraIcon } from '@heroicons/vue/24/solid'
import { Label } from '@/components/ui/label'
import { useDropZone, useEventListener } from '@vueuse/core'
import * as toast from '@/assets/js/toast'
import { Context } from '@/components/ui/context'
import Button from '@/components/ui/button/Button.vue'
import { useDialogStore } from '@/assets/js/store/dialogs'
import CameraCapture from '@/components/CameraCapture.vue'
import { useDemoMode, type DemoButtonId } from '@/assets/js/store/demoMode'
import DemoSamplePrompts from '@/components/DemoSamplePrompts.vue'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

const instance = getCurrentInstance()
const audioRecorder = useAudioRecorder()
const speechToText = useSpeechToText()
const languages = instance?.appContext.config.globalProperties.languages
const i18nState = useI18N().state
const prompt = ref('')
const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const processingDebounceTimer = ref<number | null>(null)
const openAiCompatibleChat = useOpenAiCompatibleChat()
const textInference = useTextInference()
const textareaRef = ref<HTMLTextAreaElement>()
const isTextareaFocused = ref(false)
const presetsStore = usePresets()
const dialogStore = useDialogStore()
const demoMode = useDemoMode()

audioRecorder.registerTranscriptionCallback((text) => (prompt.value = text))

// Get active chat preset
const activeChatPreset = computed(() => {
  const preset = presetsStore.activePresetWithVariant
  if (preset?.type === 'chat') return preset as ChatPreset
  return null
})

// Check if images can be attached (vision model selected)
const canAttachImages = computed(() => {
  if (promptStore.getCurrentMode() !== 'chat') return true // Allow for image modes
  return textInference.modelSupportsVision
})

// Check if documents can be attached (RAG enabled)
const canAttachDocuments = computed(() => {
  if (promptStore.getCurrentMode() !== 'chat') return false
  return activeChatPreset.value?.enableRAG === true
})

// Should show image upload button (conditional for ComfyUI presets)
const shouldShowImageUploadButton = computed(() => {
  const mode = promptStore.getCurrentMode()
  const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']

  // For ComfyUI modes, only show if preset has required image input
  if (comfyUiModes.includes(mode)) {
    if (!imageGeneration.activePreset) return false
    if (imageGeneration.activePreset.type !== 'comfy') return false

    const hasRequiredImageInput = imageGeneration.comfyInputs.some(
      (input) => input.type === 'image' && input.optional !== true,
    )

    return hasRequiredImageInput
  }

  // For chat mode, use existing logic (vision model + RAG documents)
  return canAttachImages.value || canAttachDocuments.value
})

const modesWithPresets = computed(() => {
  const modes: ModeType[] = []
  if (presetsStore.chatPresets.length > 0) modes.push('chat')
  if (presetsStore.imageGenPresets.length > 0) modes.push('imageGen')
  if (presetsStore.imageEditPresets.length > 0) modes.push('imageEdit')
  if (presetsStore.videoPresets.length > 0) modes.push('video')
  return modes
})

watch([modesWithPresets, () => promptStore.getCurrentMode()], ([modes, currentMode]) => {
  if (modes.length > 0 && currentMode && !modes.includes(currentMode)) {
    promptStore.setCurrentMode(modes[0])
  }
})

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
  (e: 'autoHideFooter'): void
  (e: 'openSettings'): void
}>()

const imagePreview = computed(() =>
  openAiCompatibleChat.fileInput.map((part, id) => ({ id, url: part.url, part })),
)

function removeImage(index: number) {
  openAiCompatibleChat.fileInput = openAiCompatibleChat.fileInput.filter((_, i) => i !== index)
}

const isProcessing = computed(() => {
  console.log('### isProcessing', {
    openAiCompatibleChatProcessing: openAiCompatibleChat.processing,
    imageGenerationProcessing: imageGeneration.processing,
  })
  return openAiCompatibleChat.processing || imageGeneration.processing
})

const isStopping = computed(() => imageGeneration.stopping)

const readyForNewSubmit = computed(() => !promptStore.promptSubmitted && !isProcessing.value)

const isFirstPrompt = computed(() => {
  const mode = promptStore.getCurrentMode()

  const isFirstChatPrompt =
    mode === 'chat' &&
    !openAiCompatibleChat.messages?.length &&
    !openAiCompatibleChat.processing &&
    !textInference.isPreparingBackend

  const isFirstImageGenPrompt =
    mode === 'imageGen' &&
    (!imageGeneration.selectedGeneratedImageId ||
      imageGeneration.selectedGeneratedImageId === 'new') &&
    !imageGeneration.processing

  // Demo preloads an edit input via copyImageAsInputForMode, which sets selectedEditedImageId.
  // Still show the sample until a real workflow output exists (those omit fromImageGen; inputs set it true).
  const hasCompletedImageEditOutput = imageGeneration.generatedImages.some(
    (item) =>
      item.mode === 'imageEdit' &&
      item.state === 'done' &&
      item.type === 'image' &&
      item.fromImageGen !== true,
  )
  const isFirstImageEditPrompt =
    mode === 'imageEdit' &&
    !imageGeneration.processing &&
    (!imageGeneration.selectedEditedImageId || (demoMode.enabled && !hasCompletedImageEditOutput))

  return isFirstChatPrompt || isFirstImageGenPrompt || isFirstImageEditPrompt
})

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
    const currentMode = promptStore.getCurrentMode()
    // Only clear prompt for chat mode; persist for ComfyUI modes (imageGen, imageEdit, video)
    if (currentMode === 'chat') {
      processingDebounceTimer.value = window.setTimeout(() => {
        prompt.value = ''
        promptStore.promptSubmitted = false
        processingDebounceTimer.value = null
      }, 1000)
    } else {
      // For ComfyUI modes, just reset the submitted flag but keep the prompt
      promptStore.promptSubmitted = false
    }
  }
})

// Sync prompt from store to textarea when switching to ComfyUI modes
watch(
  () => promptStore.getCurrentMode(),
  (newMode) => {
    const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']
    if (comfyUiModes.includes(newMode)) {
      // When switching to ComfyUI modes, sync the store prompt to the textarea
      prompt.value = imageGeneration.prompt || ''
    }
  },
)

// Keep textarea in sync with imageGeneration.prompt for ComfyUI modes
watch(
  () => imageGeneration.prompt,
  (newPrompt) => {
    const currentMode = promptStore.getCurrentMode()
    const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']
    if (comfyUiModes.includes(currentMode)) {
      // Only sync if the prompt actually changed to avoid unnecessary updates
      if (prompt.value !== newPrompt) {
        prompt.value = newPrompt || ''
      }
    }
  },
)

// Accept programmatically injected prompt text (e.g. from demo sample prompts)
watch(
  () => promptStore.injectedPromptText,
  (text) => {
    if (text !== null) {
      prompt.value = text
      promptStore.injectedPromptText = null
    }
  },
)

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
  if (demoMode.triggerFirstTimeHelp('microphone-button')) return
  if (audioRecorder.isRecording) {
    audioRecorder.stopRecording()
  } else {
    await audioRecorder.startRecording()

    if (audioRecorder.error) {
      toast.error(audioRecorder.error)
    }
  }
}

function handleCameraClick() {
  if (demoMode.triggerFirstTimeHelp('camera-button')) return
  dialogStore.showCameraDialog(async (file: File) => {
    await handleImageFiles([file])
  })
}

function handleModeClick(mode: ModeType) {
  const buttonId = `mode-button-${mode}` as DemoButtonId
  promptStore.setCurrentMode(mode)
  void nextTick(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        demoMode.triggerFirstTimeHelp(buttonId)
      })
    })
  })
}

function handleAdvancedSettingsClick() {
  if (demoMode.triggerFirstTimeHelp('advanced-settings-button')) return
  emits('openSettings')
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

// Get accepted file types based on preset capabilities
function getAcceptedFileTypes(): string {
  const mode = promptStore.getCurrentMode()
  const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']

  // For ComfyUI modes with image input, only accept images
  if (comfyUiModes.includes(mode) && shouldShowImageUploadButton.value) {
    return 'image/*'
  }

  // For chat mode, check capabilities
  if (mode === 'chat') {
    const types: string[] = []
    if (canAttachImages.value) types.push('image/*')
    if (canAttachDocuments.value) types.push('.txt,.doc,.docx,.md,.pdf')

    return types.join(',') || 'none'
  }

  // For other modes, default to none
  return 'none'
}

// Handle ComfyUI-specific image uploads
async function handleComfyUIImageUpload(imageFiles: File[]) {
  if (imageFiles.length === 0) return

  // Take only the first image
  const imageFile = imageFiles[0]
  const imageUrl = URL.createObjectURL(imageFile)

  try {
    const dataUri = await imageUrlToDataUri(imageUrl)
    const aipgMediaUrl = await saveImageToMediaInput(dataUri)

    const firstImageInput = imageGeneration.comfyInputs.find((input) => input.type === 'image')

    if (firstImageInput) {
      firstImageInput.current.value = aipgMediaUrl

      const imageItem: ImageMediaItem = {
        createdAt: Date.now(),
        id: crypto.randomUUID(),
        type: 'image',
        mode: 'imageEdit',
        state: 'done',
        imageUrl: aipgMediaUrl,
        sourceImageUrl: imageUrl,
        fromImageGen: true,
        settings: {},
      }

      imageGeneration.generatedImages.push(imageItem)
      imageGeneration.selectedEditedImageId = imageItem.id

      // Switch to imageEdit mode if not already
      if (promptStore.getCurrentMode() !== 'imageEdit') {
        promptStore.setCurrentMode('imageEdit')
      }
    }
  } catch (error) {
    console.error('Error processing image:', error)
    toast.error('Failed to load image')
  } finally {
    URL.revokeObjectURL(imageUrl)
  }
}

async function handleChatImageUpload(imageFiles: File[]) {
  const filesToProcess = await Promise.all(
    imageFiles.map((file) => downscaleImageTo1MP(file)),
  ).catch((error) => {
    console.error('Error downscaling images:', error)
    return imageFiles
  })

  const parts: FileUIPart[] = []
  for (const file of filesToProcess) {
    const objectUrl = URL.createObjectURL(file)
    try {
      const dataUri = await imageUrlToDataUri(objectUrl)
      const aipgUrl = await saveImageToMediaInput(dataUri)
      parts.push({ type: 'file', mediaType: file.type, url: aipgUrl, filename: file.name })
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }
  openAiCompatibleChat.fileInput = parts
}

// Handle image files: ComfyUI upload vs chat/other → fileInput as aipg-media
async function handleImageFiles(imageFiles: File[]) {
  if (imageFiles.length === 0) return

  if (promptStore.getCurrentMode() === 'chat') {
    await handleChatImageUpload(imageFiles)
  } else {
    await handleComfyUIImageUpload(imageFiles)
  }
}

function handlePlusIconClick(event: MouseEvent) {
  if (demoMode.triggerFirstTimeHelp('plus-icon')) {
    event.preventDefault()
    return
  }
  if (demoMode.enabled) {
    event.preventDefault()
    toast.show('Clicking this feature is disabled during demo.')
    return
  }
  // Let the Label's default behavior open the file dialog
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

  // Validate image attachments
  if (imageFiles.length > 0 && !canAttachImages.value) {
    toast.error(
      'The current model does not support image attachments. Select a vision model to attach images.',
    )
    imageFiles.length = 0
  }

  // Validate document attachments
  if (documentFiles.length > 0 && !canAttachDocuments.value) {
    toast.error(
      'Document attachments are not enabled for this preset. Use "Chat with RAG" or similar preset.',
    )
    documentFiles.length = 0
  }

  // Handle images
  if (imageFiles.length > 0) {
    await handleImageFiles(imageFiles)
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
async function onDrop(files: File[] | null) {
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

  // For ComfyUI modes with image input, only accept images
  const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']
  if (comfyUiModes.includes(promptStore.getCurrentMode()) && shouldShowImageUploadButton.value) {
    // Filter out non-image files
    if (documentFiles.length > 0) {
      toast.error('Only images can be uploaded in this mode.')
    }
    // Handle images through ComfyUI handler
    if (imageFiles.length > 0) {
      await handleImageFiles(imageFiles)
    }
    return
  }

  // Validate image attachments
  if (imageFiles.length > 0 && !canAttachImages.value) {
    toast.error(
      'The current model does not support image attachments. Select a vision model to attach images.',
    )
    imageFiles.length = 0
  }

  // Validate document attachments
  if (documentFiles.length > 0 && !canAttachDocuments.value) {
    toast.error(
      'Document attachments are not enabled for this preset. Use "Chat with RAG" or similar preset.',
    )
    documentFiles.length = 0
  }

  // Handle images
  if (imageFiles.length > 0) {
    await handleImageFiles(imageFiles)
  }

  // Handle documents
  if (documentFiles.length > 0) {
    // Validate document extensions
    const filePaths = documentFiles.map((file) => window.electronAPI.getFilePath(file))
    const fileExtensions = filePaths.map(
      (filePath) => filePath.split('.').pop()?.toLowerCase() ?? '',
    )

    if (
      fileExtensions.some((ext) => !validDocumentExtensions.includes(ext as ValidFileExtension))
    ) {
      toast.error(i18nState.RAG_UPLOAD_TYPE_ERROR)
      return
    }

    addDocumentsToRagList(documentFiles)
  }
}

// Set up drag and drop zone
const { isOverDropZone } = useDropZone(textareaRef, {
  onDrop,
  multiple: true,
  preventDefaultForUnhandled: false,
})

// Handle clipboard paste for images
function handlePaste(event: ClipboardEvent) {
  // Block image paste when vision is not supported
  if (!canAttachImages.value) return

  const items = event.clipboardData?.items
  if (!items) return

  const imageFiles: File[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) imageFiles.push(file)
    }
  }

  if (imageFiles.length > 0) {
    event.preventDefault() // Prevent default paste behavior for images
    handleImageFiles(imageFiles)
  }
}

// Attach paste event listener to textarea
useEventListener(textareaRef, 'paste', handlePaste)
</script>
