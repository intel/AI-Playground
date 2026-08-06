<template>
  <div id="prompt-area" class="text-foreground flex flex-col w-full pt-4">
    <div class="group flex flex-col items-center gap-3 text-base px-4">
      <div v-if="contextError" class="flex items-center gap-3">
        <p class="text-red-500">{{ contextError }}</p>
      </div>
      <p class="text-2xl font-bold">Let's Generate</p>
      <div class="w-full max-w-3xl flex flex-col">
        <PromptStatusBar />
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
            aria-label="Prompt"
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
                aria-label="Attach image or document"
                :accept="getAcceptedFileTypes()"
                multiple
                @change="handleFileInput"
              />
            </div>
          </div>
          <div
            id="mode-buttons"
            class="absolute bottom-4 left-3 flex gap-2"
            @pointerleave="schedulePickerClose"
          >
            <Popover
              v-for="mode in modesWithPresets"
              :key="mode"
              :open="openPickerMode === mode"
              @update:open="(val: boolean) => onPickerOpenChange(mode, val)"
            >
              <!-- Shared anchor pinned to the left edge of the button row, so every
                   mode's picker opens from the same point (using the full width) -->
              <PopoverAnchor as-child>
                <span
                  aria-hidden="true"
                  class="pointer-events-none absolute left-0 top-0 bottom-0 w-0"
                />
              </PopoverAnchor>
              <PopoverTrigger as-child>
                <Button
                  :variant="promptStore.getCurrentMode() === mode ? 'default' : 'secondary'"
                  :id="'mode-button-' + mode"
                  @pointerenter="(e: PointerEvent) => onPickerPointerEnter(mode, e)"
                  @pointerdown="onPickerPointerDown"
                  @focus="(e: FocusEvent) => onPickerFocus(mode, e)"
                  @blur="schedulePickerClose()"
                  @click="handleModeClick(mode)"
                >
                  {{ mapModeToLabel(mode) }}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                :side-offset="8"
                class="z-[40010] w-auto max-w-[80vw] rounded-lg border border-border bg-card p-2 shadow-xl"
                @open-auto-focus.prevent
                @close-auto-focus.prevent
              >
                <!-- Hover handlers live on this inner div rather than <PopoverContent>:
                     that wrapper's root is a Teleport (PopoverPortal), which drops attrs. -->
                <div
                  data-aipg-help="preset-selector"
                  class="flex gap-2 overflow-x-auto max-w-[76vw] pb-1"
                  @pointerenter="cancelPickerClose"
                  @pointerleave="schedulePickerClose"
                >
                  <TooltipProvider :delay-duration="200">
                    <Tooltip v-for="preset in presetsForMode(mode)" :key="preset.name">
                      <TooltipTrigger as-child>
                        <button
                          type="button"
                          :aria-label="preset.name"
                          :aria-pressed="presetsStore.activePresetName === preset.name"
                          :aria-disabled="!presetGate(preset).enabled"
                          :data-aipg-preset-name="preset.name"
                          class="relative flex-none w-16 h-16 rounded-md overflow-hidden border-2 transition-all duration-150"
                          :class="[
                            presetsStore.activePresetName === preset.name
                              ? 'border-primary ring-2 ring-primary'
                              : 'border-transparent',
                            presetGate(preset).enabled
                              ? 'hover:border-primary'
                              : 'opacity-40 grayscale cursor-not-allowed',
                          ]"
                          @click="selectPresetFromPicker(mode, preset)"
                        >
                          <img
                            v-if="preset.image"
                            :src="preset.image"
                            :alt="preset.name"
                            class="absolute inset-0 w-full h-full object-cover"
                          />
                          <div class="absolute bottom-0 w-full bg-background/70 px-0.5 py-0.5">
                            <span
                              class="block text-foreground text-[9px] leading-tight font-medium text-center truncate"
                            >
                              {{ preset.name }}
                            </span>
                          </div>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" class="z-[40011] max-w-[260px]">
                        <p class="font-semibold">{{ preset.name }}</p>
                        <p v-if="preset.description" class="mt-1 text-primary-foreground/80">
                          {{ preset.description }}
                        </p>
                        <p v-if="!presetGate(preset).enabled" class="mt-1 text-amber-400 text-xs">
                          {{ presetGate(preset).reason }}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <p
                    v-if="presetsForMode(mode).length === 0"
                    class="text-xs text-muted-foreground px-2 py-4 whitespace-nowrap"
                  >
                    No presets available
                  </p>
                </div>
              </PopoverContent>
            </Popover>
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
              v-if="
                promptStore.getCurrentMode() === 'chat' && !productModeStore.isNvidiaModeSelected
              "
              @click="handleRecordingClick"
              :disabled="
                (!speechToText.enabled && !audioRecorder.isRecording) ||
                audioRecorder.isTranscribing
              "
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
              aria-label="Send"
              class="px-3 py-1.5 bg-primary hover:bg-primary/80 rounded-lg text-sm min-w-[44px]"
            >
              →
            </Button>
            <Button
              v-else-if="!isStopping"
              @click="handleCancelClick"
              aria-label="Stop generating"
              aria-busy="true"
              class="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-sm min-w-[44px] flex items-center justify-center"
            >
              <i class="svg-icon w-4 h-4 i-stop"></i>
            </Button>
            <Button
              v-else
              disabled
              aria-label="Stopping"
              aria-busy="true"
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
import { useTextToSpeech } from '@/assets/js/store/textToSpeech'
import { usePromptStore } from '@/assets/js/store/promptArea'
import {
  useImageGenerationPresets,
  type ImageMediaItem,
} from '@/assets/js/store/imageGenerationPresets.ts'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useActivities } from '@/assets/js/store/activities'
import { useErrors } from '@/assets/js/store/errors'
import {
  useTextInference,
  type ValidFileExtension,
  type IndexedDocument,
} from '@/assets/js/store/textInference'
import { useI18N } from '@/assets/js/store/i18n'
import { usePresets, type ChatPreset, type Preset } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PlusIcon, PaperClipIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { CameraIcon } from '@heroicons/vue/24/solid'
import { Label } from '@/components/ui/label'
import { useDropZone, useEventListener } from '@vueuse/core'
import * as toast from '@/assets/js/toast'
import Button from '@/components/ui/button/Button.vue'
import PromptStatusBar from '@/components/PromptStatusBar.vue'
import { useDialogStore } from '@/assets/js/store/dialogs'
import CameraCapture from '@/components/CameraCapture.vue'
import { useDemoMode, type DemoButtonId } from '@/assets/js/store/demoMode'
import { useProductMode } from '@/assets/js/store/productMode'
import DemoSamplePrompts from '@/components/DemoSamplePrompts.vue'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const instance = getCurrentInstance()
const audioRecorder = useAudioRecorder()
const speechToText = useSpeechToText()
const textToSpeech = useTextToSpeech()
const languages = instance?.appContext.config.globalProperties.languages
const i18nState = useI18N().state
const prompt = ref('')
const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const processingDebounceTimer = ref<number | null>(null)
const openAiCompatibleChat = useOpenAiCompatibleChat()
const textInference = useTextInference()
const conversations = useConversations()
const activities = useActivities()
const errors = useErrors()
const textareaRef = ref<HTMLTextAreaElement>()
const isTextareaFocused = ref(false)
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const homeAgent = useHomeAgent()
const backendServices = useBackendServices()
const dialogStore = useDialogStore()

// Some chat presets are gated on a feature that the user can enable/install but
// that may currently be off. They stay visible in the picker but greyed-out and
// non-selectable (with a reason), unlike presets that are entirely unavailable on
// this system — those are filtered out upstream (e.g. aiDAPTIV™/Phison without the
// SSD, or Home Agent when the feature flag is off, which then isn't loaded at all).
const phisonUsable = computed(
  () =>
    backendServices.phisonSsdDetected &&
    (backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
      ?.llamaCppPhisonArtifactReady ??
      false) &&
    backendServices.llamaCppBuildVariant === 'ssd-offload',
)

/** Whether a picker preset is currently selectable, plus why not when disabled. */
function presetGate(preset: Preset): { enabled: boolean; reason?: string } {
  if (preset.type === 'chat' && (preset as ChatPreset).requiresPhison) {
    return phisonUsable.value
      ? { enabled: true }
      : { enabled: false, reason: 'Install and activate the aiDAPTIV™ build to use this preset.' }
  }
  if (preset.name === HOME_AGENT_CHAT_PRESET_NAME) {
    if (!homeAgent.masterEnabled) {
      return { enabled: false, reason: 'Enable the Home Agent in settings to use this preset.' }
    }
    if (!homeAgent.isAvailable) {
      return { enabled: false, reason: 'The Home Agent backend is not installed or running yet.' }
    }
    return { enabled: true }
  }
  return { enabled: true }
}

// Quick preset picker: which mode's picker popover is currently open (null = none).
const openPickerMode = ref<ModeType | null>(null)

// Mode -> preset category / type, used to list a mode's presets in the quick picker.
// Mirrors the mapping in the prompt store.
const modeToCategories: Record<ModeType, string[]> = {
  chat: ['chat'],
  imageGen: ['create-images'],
  imageEdit: ['edit-images'],
  video: ['create-videos'],
}
const modeToPresetType: Record<ModeType, 'chat' | 'comfy'> = {
  chat: 'chat',
  imageGen: 'comfy',
  imageEdit: 'comfy',
  video: 'comfy',
}

function presetsForMode(mode: ModeType): Preset[] {
  return presetsStore.getPresetsByCategories(modeToCategories[mode], modeToPresetType[mode])
}

// The picker opens on hover (mouse) with a small delay, and closes shortly after the
// pointer leaves the button row / picker — the grace delay bridges the offset gap
// between the two so the menu doesn't flicker on the way up.
const PICKER_OPEN_DELAY = 80
const PICKER_CLOSE_DELAY = 150
let pickerOpenTimer: number | null = null
let pickerCloseTimer: number | null = null
// Touch/pen users get no hover, so for them the trigger click may still open the picker.
let lastPickerPointerType = 'mouse'

function clearPickerTimers() {
  if (pickerOpenTimer !== null) {
    window.clearTimeout(pickerOpenTimer)
    pickerOpenTimer = null
  }
  if (pickerCloseTimer !== null) {
    window.clearTimeout(pickerCloseTimer)
    pickerCloseTimer = null
  }
}

function openPicker(mode: ModeType) {
  clearPickerTimers()
  // Suppressed during the guided demo so it doesn't collide with the demo help popover.
  if (demoMode.enabled) return
  if (openPickerMode.value === mode) return
  pickerOpenTimer = window.setTimeout(() => {
    pickerOpenTimer = null
    openPickerMode.value = mode
  }, PICKER_OPEN_DELAY)
}

function schedulePickerClose() {
  clearPickerTimers()
  pickerCloseTimer = window.setTimeout(() => {
    pickerCloseTimer = null
    openPickerMode.value = null
  }, PICKER_CLOSE_DELAY)
}

function cancelPickerClose() {
  clearPickerTimers()
}

function closePicker() {
  clearPickerTimers()
  openPickerMode.value = null
}

function onPickerPointerEnter(mode: ModeType, event: PointerEvent) {
  if (event.pointerType === 'mouse') openPicker(mode)
}

function onPickerFocus(mode: ModeType, event: FocusEvent) {
  // Open for keyboard focus only: clicking the button focuses it too, and that
  // click is a mode switch, not a request to open the picker.
  const target = event.target as HTMLElement | null
  if (target?.matches(':focus-visible')) openPicker(mode)
}

function onPickerPointerDown(event: PointerEvent) {
  lastPickerPointerType = event.pointerType
}

function onPickerOpenChange(mode: ModeType, open: boolean) {
  // Reka asks to open on trigger click; hover is the only opener for mouse users,
  // so only close requests (outside click / Escape) are honored there. Touch/pen
  // taps get no hover, so their click still opens the picker as before.
  if (!open) {
    closePicker()
    return
  }
  if (lastPickerPointerType !== 'mouse' && !demoMode.enabled) openPickerMode.value = mode
}

async function selectPresetFromPicker(mode: ModeType, preset: Preset) {
  // Greyed-out presets (feature off / not installed) aren't selectable — explain why.
  const gate = presetGate(preset)
  if (!gate.enabled) {
    toast.warning(gate.reason ?? 'This preset is not available yet.')
    return
  }

  closePicker() // Selecting a preset closes the picker.

  if (presetSwitching.isSwitching) {
    toast.warning('Please wait for current preset change to complete')
    return
  }
  // No-op if it's already the active preset for this mode.
  if (preset.name === presetsStore.activePresetName && promptStore.getCurrentMode() === mode) {
    return
  }

  // Hovering only opened the picker, so selecting the preset performs the mode
  // switch too (skipPresetSwitch: we pick the preset ourselves right after).
  if (!promptStore.setCurrentMode(mode, { skipPresetSwitch: true })) return

  // Route the active conversation alongside the preset, mirroring SettingsChat:
  // Home Agent jumps to its remote thread; leaving a Home Agent thread for another
  // preset spawns a fresh main conversation so we don't write into Home Agent state.
  const switchingToHomeAgent = preset.name === HOME_AGENT_CHAT_PRESET_NAME
  const onHomeAgentThread = conversations.getThreadKind(conversations.activeKey) === 'homeAgent'

  const result = await presetSwitching.switchPreset(preset.name, { skipModeSwitch: true })
  if (result.success) {
    if (switchingToHomeAgent) {
      conversations.activeKey = homeAgent.ensureActiveRemoteConversation()
    } else if (onHomeAgentThread) {
      conversations.addNewConversation()
    }
    toast.success(`Switched to ${preset.name}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}
const demoMode = useDemoMode()
const productModeStore = useProductMode()

audioRecorder.registerTranscriptionCallback((text) => {
  prompt.value = text
  // Mark this as a voice-originated turn so the reply can be auto-spoken.
  textToSpeech.pendingVoiceTurn = true
})

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

// Busy state is unified through the activity sink: in addition to the streaming /
// generation flags, any active chat activity for the current conversation (backend
// prep, RAG search, tool resolution, thinking) keeps the prompt area in its busy
// state so the send/stop control matches the in-turn activity indicator.
const isProcessing = computed(
  () =>
    openAiCompatibleChat.processing ||
    imageGeneration.processing ||
    // Model/backend load runs before the chat stream starts (so `processing` is
    // still false); keep the busy state up for it too, so the send/stop control
    // is the single, complete signal for "is the app working on this turn".
    textInference.isPreparingBackend ||
    activities.chatActivity(conversations.activeKey) !== null,
)

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
  // The TTS preset runs in 'chat' mode but takes literal text to speak, not a
  // chat prompt — so it needs its own placeholder.
  const active = presetsStore.activePreset
  if (active?.type === 'chat' && active.ttsPreset) {
    return languages?.COM_PROMPT_TTS || ''
  }
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
  const needsPrompt = promptStore.getCurrentMode() === 'chat' || imageGeneration.requiresUserPrompt
  if (needsPrompt && !prompt.value.trim()) {
    toast.error(languages?.COM_ERROR_NO_MESSAGE || 'Please enter a message before sending.')
    return
  }
  emits('autoHideFooter')
  promptStore.submitPrompt(prompt.value)
}

function handleCancelClick() {
  promptStore.cancelProcessing()
}

async function handleRecordingClick() {
  if (demoMode.triggerFirstTimeHelp('microphone-button')) return
  // Stop must stay reachable even if speech-to-text was disabled mid-recording.
  if (audioRecorder.isRecording) {
    audioRecorder.stopRecording()
    return
  }
  if (!speechToText.enabled) return
  await audioRecorder.startRecording()

  if (audioRecorder.error) {
    errors.report(audioRecorder.error, {
      category: 'inference',
      code: 'inference/audio-record-failed',
      userMessage: audioRecorder.error,
    })
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
  // Clicking switches the mode only; the quick preset picker opens on hover, and
  // closing it here keeps the menu from being dragged along by the layout shift
  // a mode switch can cause.
  closePicker()
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
    errors.report(error, {
      category: 'inference',
      code: 'inference/image-load-failed',
      userMessage: 'Failed to load image',
    })
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
      'Document attachments are not enabled for this preset. Use the "Assistant" preset or similar.',
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
      errors.report(error, {
        category: 'inference',
        code: 'inference/rag-add-failed',
        userMessage: i18nState.RAG_UPLOAD_TYPE_ERROR,
      })
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
      'Document attachments are not enabled for this preset. Use the "Assistant" preset or similar.',
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
