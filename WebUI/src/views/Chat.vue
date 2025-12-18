<template>
  <button
    v-if="showScrollButton"
    class="absolute bottom-65 left-1/2 transform -translate-x-1/2 bg-background text-foreground p-2 rounded-full shadow-lg z-50 hover:bg-muted transition-colors"
    @click="scrollToBottom()"
    title="Scroll to bottom"
  >
    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
    </svg>
  </button>
  <div
    v-if="(activeConversation && activeConversation.length > 0) || openAiCompatibleChat.processing"
    id="chatPanel"
    ref="chatPanel"
    class="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6 relative"
    @scroll="handleScroll"
  >
    <div
      class="absolute inset-0 flex justify-center items-center bg-background/30 z-10"
      v-if="textInference.isPreparingBackend"
    >
      <loading-bar :text="textInference.preparationMessage" class="w-512px"></loading-bar>
    </div>

    <!-- eslint-disable vue/require-v-for-key -->
    <div class="w-full max-w-4xl mx-auto flex flex-col gap-6">
      <template v-for="(message, i) in activeConversation">
        <!-- eslint-enable -->
        <div v-if="message.role === 'user'" class="flex items-start gap-3">
          <UserCircleIcon :class="textInference.iconSizeClass" class="text-foreground/90" />
          <div class="flex flex-col gap-3 max-w-4/5 bg-muted rounded-md px-4 py-3">
            <p class="text-muted-foreground" :class="textInference.nameSizeClass">
              {{ languages.ANSWER_USER_NAME }}
            </p>
            <img
              v-if="
                message.parts.find(
                  (part) => part.type === 'file' && part.mediaType?.startsWith('image/'),
                )
              "
              :src="
                (
                  message.parts.find(
                    (part) => part.type === 'file' && part.mediaType?.startsWith('image/'),
                  ) as { url?: string }
                )?.url
              "
              alt="Generated Image"
            />
            <div
              :class="textInference.fontSizeClass"
              v-html="parse(message.parts.find((part) => part.type === 'text')?.text ?? '')"
            ></div>
            <button
              class="flex items-center gap-1 text-xs text-muted-foreground mt-1"
              :title="languages.COM_COPY"
              @click="copyText(message.parts.find((part) => part.type === 'text')?.text || '')"
            >
              <span class="svg-icon i-copy w-4 h-4"></span>
              <span>{{ languages.COM_COPY }}</span>
            </button>
          </div>
        </div>
        <div v-else-if="message.role === 'assistant'" class="flex items-start gap-3">
          <img :class="textInference.iconSizeClass" src="../assets/svg/ai-icon.svg" />
          <div class="flex flex-col gap-3 max-w-[90%] text-wrap break-words">
            <div class="flex items-center gap-2">
              <p class="text-muted-foreground mt-0.75" :class="textInference.nameSizeClass">
                {{ languages.ANSWER_AI_NAME }}
              </p>
              <div
                v-if="(message.metadata as { model?: string }).model"
                class="flex items-center gap-2"
              >
                <span
                  class="bg-secondary text-foreground font-sans rounded-md px-1 py-1"
                  :class="textInference.nameSizeClass"
                >
                  {{
                    message.metadata?.model?.endsWith('.gguf')
                      ? (message.metadata?.model?.split('/').at(-1)?.split('.gguf')[0] ??
                        message.metadata?.model)
                      : message.metadata?.model
                  }}
                </span>
                <!-- Display RAG source if available -->
                <span
                  v-if="
                    (message.metadata as { ragSource?: string })?.ragSource ||
                    ragSourcePerMessageId[message.id]
                  "
                  @click="
                    showRagSourcePerMessageId[message.id] = !showRagSourcePerMessageId[message.id]
                  "
                  class="bg-primary text-foreground font-sans rounded-md px-1 py-1 cursor-pointer"
                  :class="textInference.nameSizeClass"
                >
                  Source Docs
                  <button class="ml-1">
                    <img
                      v-if="showRagSourcePerMessageId[message.id]"
                      src="../assets/svg/arrow-up.svg"
                      class="w-3 h-3"
                    />
                    <img v-else src="../assets/svg/arrow-down.svg" class="w-3 h-3" />
                  </button>
                </span>
              </div>
            </div>

            <!-- RAG Source Details (collapsible) -->
            <div
              v-if="
                showRagSourcePerMessageId[message.id] &&
                (message.metadata?.ragSource || ragSourcePerMessageId[message.id])
              "
              class="my-2 text-muted-foreground border-l-2 border-primary pl-2 flex flex-row gap-1"
              :class="textInference.fontSizeClass"
            >
              <div class="font-bold">{{ i18nState.RAG_SOURCE }}:</div>
              <div class="whitespace-pre-wrap">
                {{ message.metadata?.ragSource || ragSourcePerMessageId[message.id] }}
              </div>
            </div>
            <div class="ai-answer chat-content" :class="textInference.fontSizeClass">
              <template v-if="message.parts.some((part) => part.type === 'reasoning')">
                <div class="mb-2 flex items-center">
                  <span class="italic text-muted-foreground">
                    {{
                      message.metadata?.reasoningFinished && message.metadata?.reasoningStarted
                        ? `Done Reasoning after ${((message.metadata.reasoningFinished - message.metadata.reasoningStarted) / 1000).toFixed(1)} seconds`
                        : `Reasoned for ${(
                            (Date.now() - (message.metadata?.reasoningStarted ?? 0)) /
                            1000
                          ).toFixed(1)} seconds`
                    }}
                  </span>
                  <button
                    @click="
                      showThinkingTextPerMessageId[message.id] =
                        !showThinkingTextPerMessageId[message.id]
                    "
                    class="ml-1"
                  >
                    <img
                      v-if="showThinkingTextPerMessageId[message.id]"
                      src="../assets/svg/arrow-up.svg"
                      class="w-4 h-4"
                    />
                    <img v-else src="../assets/svg/arrow-down.svg" class="w-4 h-4" />
                  </button>
                </div>
                <div
                  v-if="showThinkingTextPerMessageId[message.id]"
                  class="border-l-2 border-border pl-4 text-muted-foreground"
                  v-html="
                    parse(message.parts.find((part) => part.type === 'reasoning')?.text ?? '')
                  "
                ></div>
              </template>
              <div
                v-html="parse(message.parts.find((part) => part.type === 'text')?.text ?? '')"
              ></div>

              <!-- Render tool parts -->
              <template
                v-for="part in message.parts.filter((p) => p.type.startsWith('tool-'))"
                :key="
                  part.type === 'tool-comfyUI'
                    ? `tool-${part.toolCallId}`
                    : part.type === 'tool-visualizeObjectDetections'
                      ? `tool-${part.toolCallId}`
                      : undefined
                "
              >
                <span>I'm using the tool {{ part.type.replace('tool-', '') }}</span>
                <template v-if="part.type === 'tool-comfyUI'">
                  <div class="mt-1 pt-1">
                    <span
                      >Generating using the preset
                      <b>{{ part.input?.workflow ?? 'unknown' }}</b></span
                    >
                    <br />
                    <br />
                    <span
                      ><em>{{ part.input?.prompt ?? '' }}</em></span
                    >
                    <ChatWorkflowResult
                      :images="getToolImages(part)"
                      :processing="getToolProcessing(part)"
                      :currentState="getToolCurrentState(part)"
                      :stepText="getToolStepText(part)"
                      :toolCallId="(part as any).toolCallId"
                    />
                  </div>
                </template>
                <template v-else-if="part.type === 'tool-visualizeObjectDetections'">
                  <div class="mt-1 pt-1">
                    <div
                      v-if="
                        part.state === 'output-available' && (part as any).output?.annotatedImageUrl
                      "
                    >
                      <img
                        :src="(part as any).output.annotatedImageUrl"
                        alt="Annotated image with object detections"
                        class="max-w-full rounded-md border-2 border-border"
                      />
                    </div>
                    <div
                      v-else-if="
                        part.state === 'input-streaming' || part.state === 'input-available'
                      "
                    >
                      <span class="text-muted-foreground">Visualizing object detections...</span>
                    </div>
                  </div>
                </template>
              </template>
            </div>
            <div class="answer-tools flex gap-3 items-center text-muted-foreground">
              <button
                class="flex items-end"
                :title="languages.COM_COPY"
                @click="copyText(message.parts.find((part) => part.type === 'text')?.text || '')"
              >
                <span class="svg-icon i-copy w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_COPY }}</span>
              </button>
              <button
                class="flex items-end"
                :title="languages.COM_REGENERATE"
                @click="() => openAiCompatibleChat.regenerate(message.id)"
                v-if="i + 1 == activeConversation.length"
                :disabled="openAiCompatibleChat.processing"
                :class="{ 'opacity-50 cursor-not-allowed': openAiCompatibleChat.processing }"
              >
                <span class="svg-icon i-refresh w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_REGENERATE }}</span>
              </button>
              <button
                class="flex items-end"
                :title="languages.COM_DELETE"
                @click="
                  () => {
                    openAiCompatibleChat.removeMessage(message.id)
                  }
                "
              >
                <span class="svg-icon i-delete w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_DELETE }}</span>
              </button>
            </div>
            <div
              v-if="textInference.metricsEnabled && message.metadata?.timings"
              class="metrics-info text-xs text-muted-foreground"
            >
              <span class="mr-2">{{ message.metadata?.timings.predicted_n }} Tokens</span>
              <span class="mr-2">⋅</span>
              <span class="mr-2"
                >{{ message.metadata?.timings.predicted_per_second.toFixed(2) }} Tokens/s</span
              >
              <span class="mr-2">⋅</span>
              <span class="mr-2"
                >1st Token Time: {{ message.metadata?.timings.prompt_ms.toFixed(2) }}ms</span
              >
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getCurrentInstance } from 'vue'
import * as toast from '@/assets/js/toast.ts'
import { useI18N } from '@/assets/js/store/i18n.ts'
import { useTextInference } from '@/assets/js/store/textInference.ts'
import { parse } from '@/assets/js/markdownParser.ts'
import LoadingBar from '@/components/LoadingBar.vue'
import { usePromptStore } from '@/assets/js/store/promptArea.ts'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import {
  useImageGenerationPresets,
  type MediaItem,
  type GenerateState,
} from '@/assets/js/store/imageGenerationPresets'
import { useComfyUiPresets } from '@/assets/js/store/comfyUiPresets'
import { ToolUIPart } from 'ai'
import { AipgTools } from '@/assets/js/tools/tools'
import { base64ToString } from 'uint8array-extras'
import { UserCircleIcon } from '@heroicons/vue/24/outline'

const openAiCompatibleChat = useOpenAiCompatibleChat()
const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const textInference = useTextInference()
const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const comfyUi = useComfyUiPresets()

const i18nState = useI18N().state
const autoScrollEnabled = ref(true)
const showScrollButton = ref(false)
const chatPanel = ref<HTMLElement | null>(null)

const activeConversation = computed(() => openAiCompatibleChat.messages)
const showThinkingTextPerMessageId = reactive<Record<string, boolean>>({})
const showRagSourcePerMessageId = reactive<Record<string, boolean>>({})

const ragSourcePerMessageId = reactive<Record<string, string>>({})

// Track progress for active tool calls
const toolProgressMap = reactive<
  Record<
    string,
    {
      processing: boolean
      currentState?: GenerateState
      stepText?: string
      images: MediaItem[]
      initialImageIds: Set<string> // Track which image IDs existed when tool call started
    }
  >
>({})

defineExpose({
  scrollToBottom,
})

onMounted(() => {
  promptStore.registerSubmitCallback('chat', handlePromptSubmit)
  promptStore.registerCancelCallback('chat', handleCancel)
})

onUnmounted(() => {
  promptStore.unregisterSubmitCallback('chat')
  promptStore.unregisterCancelCallback('chat')
})

watch(
  () => openAiCompatibleChat.messages,
  (messages) => {
    // Initialize RAG source display state from message metadata
    if (messages) {
      messages.forEach((message) => {
        const ragSource = (message.metadata as { ragSource?: string })?.ragSource
        if (ragSource && !ragSourcePerMessageId[message.id]) {
          ragSourcePerMessageId[message.id] = ragSource
          // Default to collapsed state
          showRagSourcePerMessageId[message.id] = false
        }
      })
    }

    if (autoScrollEnabled.value) {
      nextTick(() => scrollToBottom())
    }
    nextTick(() => {
      if (chatPanel.value) {
        chatPanel.value.querySelectorAll('.copy-code').forEach((item) => {
          const el = item as HTMLElement
          el.classList.remove('hidden')
          el.removeEventListener('click', copyCode)
          el.addEventListener('click', copyCode)
        })
      }
    })
  },
  { deep: true, immediate: true },
)

async function handlePromptSubmit(prompt: string) {
  const question = prompt.trim()
  if (question == '') {
    toast.error(useI18N().state.ANSWER_ERROR_NOT_PROMPT)
    promptStore.promptSubmitted = false
    return
  }
  try {
    nextTick(scrollToBottom)
    await openAiCompatibleChat.generate(question)
  } catch (error) {
    // Reset state on any error (including download cancellation)
    promptStore.promptSubmitted = false
    console.error('Error during text inference:', error)
  }
}

function handleCancel() {
  // Fire off stop requests without awaiting to immediately unblock UI
  if (openAiCompatibleChat.processing) {
    openAiCompatibleChat.stop()
  }
  // Also cancel any ongoing ComfyUI inference from tool calls
  comfyUi.stop()

  // Immediately reset prompt state to unblock UI
  promptStore.promptSubmitted = false
}

function handleScroll(e: Event) {
  const target = e.target as HTMLElement
  const distanceFromBottom = target.scrollHeight - (target.scrollTop + target.clientHeight)

  autoScrollEnabled.value = distanceFromBottom <= 35
  showScrollButton.value = distanceFromBottom > 60
}

function scrollToBottom(smooth = true) {
  if (chatPanel.value) {
    chatPanel.value.scrollTo({
      top: chatPanel.value.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    })
  }
}

function copyCode(e: MouseEvent) {
  if (!(e.target instanceof HTMLElement)) return
  if (!e.target?.dataset?.code) return
  copyText(base64ToString(e.target?.dataset?.code))
}

function copyText(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      toast.success(i18nState.COM_COPY_SUCCESS_TIP)
    })
    .catch((e) => console.error('Error while copying text to clipboard', e))
}

// Helper functions for tool rendering
function getToolImages(part: ToolUIPart<AipgTools>): MediaItem[] {
  if (part.type !== 'tool-comfyUI') return []
  const toolCallId = part.toolCallId
  const progress = toolProgressMap[toolCallId]

  // If we have progress tracking with images, use those
  if (progress && progress.images.length > 0) {
    return progress.images
  }

  // Otherwise, use output images if available
  if (part.state === 'output-available') {
    if (!part.output) return []
    return part.output.images.map((img) => ({ ...img, state: 'done' as const }))
  }

  return []
}

function getToolProcessing(part: ToolUIPart<AipgTools>): boolean {
  const toolCallId = part.toolCallId
  const progress = toolProgressMap[toolCallId]

  // If we have progress tracking, use that
  if (progress) {
    return progress.processing
  }

  // Otherwise, check part state
  return part.state === 'input-streaming' || part.state === 'input-available'
}

function getToolCurrentState(part: ToolUIPart<AipgTools>): GenerateState | undefined {
  const toolCallId = part.toolCallId
  const progress = toolProgressMap[toolCallId]

  if (progress && progress.currentState) {
    return progress.currentState as GenerateState
  }

  return undefined
}

function getToolStepText(part: ToolUIPart<AipgTools>): string | undefined {
  const toolCallId = part.toolCallId
  const progress = toolProgressMap[toolCallId]

  if (progress && progress.stepText) {
    return progress.stepText
  }

  return undefined
}

// Watch for new tool calls starting to initialize their image tracking
watch(
  () => activeConversation.value,
  (messages) => {
    if (!messages) return

    // Find tool calls that just started (input-streaming or input-available)
    messages.forEach((msg) => {
      msg.parts.forEach((part) => {
        if (part.type === 'tool-comfyUI') {
          const toolCallId = part.toolCallId
          const state = part.state

          // If this tool call just started and we haven't initialized it yet
          if (
            (state === 'input-streaming' || state === 'input-available') &&
            !toolProgressMap[toolCallId]
          ) {
            // Record the current set of image IDs to exclude them from this tool call's images
            const currentImageIds = new Set(imageGeneration.generatedImages.map((img) => img.id))
            toolProgressMap[toolCallId] = {
              processing: true,
              images: [],
              initialImageIds: currentImageIds,
            }
          }
        }
      })
    })
  },
  { deep: true },
)

// Watch imageGeneration store to track progress for active tool calls
watch(
  () => [
    imageGeneration.generatedImages,
    imageGeneration.processing,
    imageGeneration.currentState,
    imageGeneration.stepText,
  ],
  () => {
    // Find active tool calls that are processing
    const activeToolParts =
      activeConversation.value
        ?.flatMap((msg) => msg.parts)
        .filter(
          (part) =>
            part.type === 'tool-comfyUI' &&
            (part.state === 'input-streaming' || part.state === 'input-available'),
        )
        .map((part) => ({
          toolCallId: part.toolCallId,
          part,
        })) || []

    // Update progress for each active tool call
    activeToolParts.forEach(({ toolCallId }) => {
      const progress = toolProgressMap[toolCallId]
      if (!progress) return

      // Only get images that were created for this tool call (not in initial set)
      const toolCallImages = imageGeneration.generatedImages
        .filter((img) => !progress.initialImageIds.has(img.id))
        .filter(
          (img) => img.state === 'queued' || img.state === 'generating' || img.state === 'done',
        )
        // Filter out items without valid URL based on type
        .filter((img) => {
          if (img.type === 'image') return img.imageUrl && img.imageUrl.trim() !== ''
          if (img.type === 'video') return img.videoUrl && img.videoUrl.trim() !== ''
          if (img.type === 'model3d') return img.model3dUrl && img.model3dUrl.trim() !== ''
          return false
        })
        .map((img) => ({ ...img }))

      progress.images = toolCallImages
      progress.processing = imageGeneration.processing
      progress.currentState = imageGeneration.currentState
      progress.stepText = imageGeneration.stepText
    })
  },
  { deep: true },
)

// Also watch processing state
watch(
  () => imageGeneration.processing,
  (processing) => {
    // Get the set of currently active tool call IDs (input-streaming or input-available)
    const activeToolCallIds = new Set(
      activeConversation.value
        ?.flatMap((msg) => msg.parts)
        .filter(
          (part) =>
            part.type === 'tool-comfyUI' &&
            (part.state === 'input-streaming' || part.state === 'input-available'),
        )
        .map((part) => part.toolCallId) || [],
    )

    Object.keys(toolProgressMap).forEach((toolCallId) => {
      const progress = toolProgressMap[toolCallId]
      if (!progress) return

      if (processing) {
        // When processing starts, only set processing=true for active tool calls
        // This prevents completed tool calls from showing the progress indicator again
        if (activeToolCallIds.has(toolCallId)) {
          progress.processing = true
        }
      } else {
        // When processing stops, update any tool call that was processing
        // (it may no longer be "active" since its state changed to output-available)
        if (progress.processing) {
          progress.processing = false
          // Mark images as done and filter out any without valid URL
          progress.images = progress.images
            .filter((img) => {
              if (img.type === 'image') return img.imageUrl && img.imageUrl.trim() !== ''
              if (img.type === 'video') return img.videoUrl && img.videoUrl.trim() !== ''
              if (img.type === 'model3d') return img.model3dUrl && img.model3dUrl.trim() !== ''
              return false
            })
            .map((img) => ({
              ...img,
              state: 'done' as const,
            }))
        }
      }
    })
  },
)
</script>

<style>
.shiki {
  padding-left: 0.5rem;
  border-bottom-left-radius: calc(var(--radius) - 2px);
  border-bottom-right-radius: calc(var(--radius) - 2px);
}
</style>
