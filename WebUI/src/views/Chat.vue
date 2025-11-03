<template>
  <div
    v-if="
      (activeConversation && activeConversation.length > 0) ||
      processing
    "
    id="chatPanel"
    ref="chatPanel"
    class="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6"
    @scroll="handleScroll"
  >
    <div
      class="absolute inset-0 flex justify-center items-center bg-black/30 z-10"
      v-if="textInference.isPreparingBackend"
    >
      <loading-bar :text="textInference.preparationMessage" class="w-512px"></loading-bar>
    </div>
    <!-- eslint-disable vue/require-v-for-key -->
    <div class="w-full max-w-3xl mx-auto flex flex-col gap-6">
      <template v-for="(message, i) in activeConversation">
        <!-- eslint-enable -->
        <div v-if="message.role === 'user'" class="flex items-start gap-3">
          <img :class="textInference.iconSizeClass" src="../assets/svg/user-icon.svg" />
          <div class="flex flex-col gap-3 max-w-3/4">
            <p class="text-gray-300" :class="textInference.nameSizeClass">
              {{ languages.ANSWER_USER_NAME }}
            </p>
            <img
              v-if="message.parts.find((part) => part.type === 'file' && part.mediaType.startsWith('image/'))"
              :src="message.parts.find((part) => part.type === 'file' && part.mediaType.startsWith('image/')).url"
              alt="Generated Image"
            />
            <div v-html="parse(message.parts.find((part) => part.type === 'text')?.text ?? '')"></div>
            <button
              class="flex items-center gap-1 text-xs text-gray-300 mt-1"
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
          <div
            class="flex flex-col gap-3 bg-gray-600 rounded-md px-4 py-3 max-w-3/4 text-wrap break-words"
          >
            <div class="flex items-center gap-2">
              <p class="text-gray-300 mt-0.75" :class="textInference.nameSizeClass">
                {{ languages.ANSWER_AI_NAME }}
              </p>
              <div v-if="(message.metadata as { model?: string }).model" class="flex items-center gap-2">
                <span
                  class="bg-gray-400 text-black font-sans rounded-md px-1 py-1"
                  :class="textInference.nameSizeClass"
                >
                  {{
                    (message.metadata as { model?: string }).model?.endsWith('.gguf')
                      ? ((message.metadata as { model?: string }).model?.split('/').at(-1)?.split('.gguf')[0] ?? (message.metadata as { model?: string }).model)
                      : (message.metadata as { model?: string }).model
                  }}
                </span>
                <!-- Display RAG source if available -->
                <!-- <span
                  v-if="chatItem.ragSource"
                  @click="chatItem.showRagSource = !chatItem.showRagSource"
                  class="bg-purple-400 text-black font-sans rounded-md px-1 py-1 cursor-pointer"
                  :class="textInference.nameSizeClass"
                >
                  Source Docs
                  <button class="ml-1">
                    <img
                      v-if="chatItem.showRagSource"
                      src="../assets/svg/arrow-up.svg"
                      class="w-3 h-3"
                    />
                    <img v-else src="../assets/svg/arrow-down.svg" class="w-3 h-3" />
                  </button>
                </span> -->
              </div>
            </div>

            <!-- RAG Source Details (collapsible) -->
            <!-- <div
              v-if="chatItem.ragSource && chatItem.showRagSource"
              class="my-2 text-gray-300 border-l-2 border-purple-400 pl-2 flex flex-row gap-1"
              :class="textInference.fontSizeClass"
            >
              <div class="font-bold">{{ i18nState.RAG_SOURCE }}:</div>
              <div class="whitespace-pre-wrap">{{ chatItem.ragSource }}</div>
            </div> -->
            <div class="ai-answer chat-content">
              <template v-if="message.parts.some((part) => part.type === 'reasoning')">
                <div class="mb-2 flex items-center">
                   <span class="italic text-gray-300">
                    {{
                      message.metadata?.reasoningFinished && message.metadata?.reasoningStarted
                        ? `Done Reasoning after ${((message.metadata.reasoningFinished - message.metadata.reasoningStarted) / 1000).toFixed(1)} seconds`
                        : `Reasoned for ${
                            ((Date.now() - (message.metadata?.reasoningStarted ?? 0)) / 1000).toFixed(1)
                          } seconds`
                    }}
                  </span>
                  <button
                    @click="showThinkingTextPerMessageId[message.id] = !showThinkingTextPerMessageId[message.id]"
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
                  class="border-l-2 border-gray-400 pl-4 text-gray-300"
                  v-html="parse(message.parts.find((part) => part.type === 'reasoning')?.text ?? '')"
                ></div>
              </template>
              <div v-html="parse(message.parts.find((part) => part.type === 'text')?.text ?? '')"></div>
            </div>
            <div class="answer-tools flex gap-3 items-center text-gray-300">
              <button
                class="flex items-end"
                :title="languages.COM_COPY"
                @click="
                  copyText(
                    message.parts.find((part) => part.type === 'text')?.text || ''
                  )
                "
              >
                <span class="svg-icon i-copy w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_COPY }}</span>
              </button>
              <button
                class="flex items-end"
                :title="languages.COM_REGENERATE"
                @click="() => openAiCompatibleChat.chat.regenerate({messageId: message.id})"
                v-if="i + 1 == conversations.activeConversation.length"
                :disabled="processing"
                :class="{ 'opacity-50 cursor-not-allowed': processing }"
              >
                <span class="svg-icon i-refresh w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_REGENERATE }}</span>
              </button>
              <button
                class="flex items-end"
                :title="languages.COM_DELETE"
                @click="() => {openAiCompatibleChat.removeMessage(message.id)}"
              >
                <span class="svg-icon i-delete w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_DELETE }}</span>
              </button>
            </div>
            <div
              v-if="textInference.metricsEnabled && message.metadata?.timings"
              class="metrics-info text-xs text-gray-400"
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
      <!-- <div
        class="flex items-start gap-3"
        v-show="processing && conversations.activeKey === currentlyGeneratingKey"
      >
        <img :class="textInference.iconSizeClass" src="../assets/svg/user-icon.svg" />
        <div class="flex flex-col gap-3 max-w-3/4">
          <p class="text-gray-300" :class="textInference.nameSizeClass">
            {{ languages.ANSWER_USER_NAME }}
          </p>
          <div class="chat-content" style="white-space: pre-wrap">
            {{ textIn }}
          </div>
          <button
            class="flex items-center gap-1 text-xs text-gray-300 mt-1"
            :title="languages.COM_COPY"
            @click="copyText(textIn)"
          >
            <span class="svg-icon i-copy w-4 h-4"></span>
            <span>{{ languages.COM_COPY }}</span>
          </button>
        </div>
      </div>
      <div
        class="flex items-start gap-3"
        v-show="processing && conversations.activeKey === currentlyGeneratingKey"
      >
        <img :class="textInference.iconSizeClass" src="../assets/svg/ai-icon.svg" />
        <div
          class="flex flex-col gap-3 bg-gray-600 rounded-md px-4 py-3 max-w-3/4 text-wrap break-words"
        >
          <div class="flex items-center gap-2">
            <p class="text-gray-300 mt-0.75" :class="textInference.nameSizeClass">
              {{ languages.ANSWER_AI_NAME }}
            </p>
            <span
              class="bg-gray-400 text-black font-sans rounded-md px-1 py-1"
              :class="textInference.nameSizeClass"
            >
              {{ textInference.activeModel }}
            </span>
            <span
              v-if="ragRetrievalInProgress || actualRagResults?.length"
              class="bg-purple-400 text-black font-sans rounded-md px-1 py-1 cursor-pointer"
              :class="textInference.nameSizeClass"
              @click="showRagPreview = !showRagPreview"
            >
              Source Docs
              <button class="ml-1">
                <img v-if="showRagPreview" src="../assets/svg/arrow-up.svg" class="w-3 h-3" />
                <img v-else src="../assets/svg/arrow-down.svg" class="w-3 h-3" />
              </button>
            </span>
          </div>

          <div
            v-if="showRagPreview"
            class="my-2 text-gray-300 border-l-2 border-purple-400 pl-2 flex flex-row gap-1"
            :class="textInference.fontSizeClass"
          >
            <div class="font-bold">{{ i18nState.RAG_SOURCE }}:</div>
            <div v-if="ragRetrievalInProgress" class="whitespace-pre-wrap">
              Retrieving Documents...
            </div>
            <div v-else-if="actualRagResults?.length" class="whitespace-pre-wrap">
              {{ textInference.formatRagSources(actualRagResults) }}
            </div>
          </div>
          <div
            v-if="!downloadModel.downloading && !loadingModel"
            :class="[
              'ai-answer',
              {
                'cursor-block': !(
                  textInference.activeModel && thinkingModels[textInference.activeModel]
                ),
              },
              'break-all',
            ]"
          >
            <template v-if="textInference.activeModel && thinkingModels[textInference.activeModel]">
              <div class="mb-2 flex items-center">
                <span class="italic text-gray-300 inline-flex items-center">
                  <template v-if="thinkingText || postMarkerText">
                    <span v-if="reasoningTotalTime !== 0" class="inline-block mr-1">
                      {{ `Reasoned for ${(reasoningTotalTime / 1000).toFixed(1)} seconds` }}
                    </span>
                    <span v-else class="inline-block w-[9ch] truncate">
                      {{ animatedReasoningText }}
                    </span>

                    <button @click="showThinkingText = !showThinkingText" class="flex items-center">
                      <img
                        v-if="showThinkingText"
                        src="../assets/svg/arrow-up.svg"
                        class="w-4 h-4"
                      />
                      <img v-else src="../assets/svg/arrow-down.svg" class="w-4 h-4" />
                    </button>
                  </template>
                  <template v-else>
                    <span class="cursor-block"></span>
                  </template>
                </span>
              </div>
              <div
                v-if="showThinkingText"
                class="border-l-2 border-gray-400 pl-4 text-gray-300"
                v-html="thinkOut"
              ></div>
              <div class="mt-2 text-white" v-html="textOut"></div>
            </template>
            <template v-else>
              <span v-html="textOut"></span>
            </template>
          </div>
          <div v-else class="px-20 h-24 w-768px flex items-center justify-center">
            <progress-bar
              v-if="downloadModel.downloading"
              :text="downloadModel.text"
              :percent="downloadModel.percent"
              class="w-512px"
            ></progress-bar>
            <loading-bar
              v-else-if="loadingModel"
              :text="languages.COM_LOADING_MODEL"
              class="w-512px"
            ></loading-bar>
          </div>
        </div>
      </div> -->
    </div>
  </div>
</template>

<script setup lang="ts">
import { getCurrentInstance } from 'vue'
import * as toast from '@/assets/js/toast.ts'
import { useI18N } from '@/assets/js/store/i18n.ts'
import { thinkingModels, useTextInference } from '@/assets/js/store/textInference.ts'
import { useConversations } from '@/assets/js/store/conversations.ts'
import * as util from '@/assets/js/util.ts'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { useGlobalSetup } from '@/assets/js/store/globalSetup.ts'
import { parse } from '@/assets/js/markdownParser.ts'
import { base64ToString } from 'uint8array-extras'
import ProgressBar from '@/components/ProgressBar.vue'
import LoadingBar from '@/components/LoadingBar.vue'
import { usePromptStore } from "@/assets/js/store/promptArea.ts";
import { AipgUiMessage, useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { asyncComputed } from '@vueuse/core'

const openAiCompatibleChat = useOpenAiCompatibleChat()
const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const textInference = useTextInference()
const conversations = useConversations()
const backendServices = useBackendServices()
const promptStore = usePromptStore()
const processing = ref(false)

const i18nState = useI18N().state
const ragRetrievalInProgress = ref(false)
const showRagPreview = ref(true)
const autoScrollEnabled = ref(true)
const showScrollButton = ref(false)
const chatPanel = ref<HTMLElement | null>(null)

const activeConversation = computed(() => openAiCompatibleChat.messages)
const showThinkingTextPerMessageId = reactive<Record<string, boolean>>({})

let actualRagResults: LangchainDocument[] | null = null

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


async function handleSubmitPromptClick(prompt: string) {
  const question = prompt.trim()
  if (question == '') {
    toast.error(useI18N().state.ANSWER_ERROR_NOT_PROMPT)
    return
  }
  try {
    await textInference.checkModelAvailability()

    generate(question)
  } catch {}
}

async function handleCancel() {
  if (processing.value && !stopping.value) {
    stopping.value = true
    await fetch(`${textInference.currentBackendUrl}/api/llm/stopGenerate`)
    if (abortController) {
      abortController.abort()
      abortController = null
    }

    finishGenerate()
    processing.value = false
    promptStore.textInferenceProcessing = false
    stopping.value = false
  }
}


async function generate(question: string) {
  try {
    if (textInference.needsBackendPreparation) {
      textInference.startBackendPreparation()

      try {
        await textInference.ensureBackendReadiness()
      } catch (error) {
        throw error
      } finally {
        textInference.completeBackendPreparation()
      }
    } else {
      await textInference.ensureBackendReadiness()
    }

    const backendToInferenceService = {
      llamaCPP: 'llamacpp-backend',
      openVINO: 'openvino-backend',
      ipexLLM: 'ai-backend',
      ollama: 'ollama-backend' as BackendServiceName,
    } as const
    const inferenceBackendService = backendToInferenceService[textInference.backend]
    await backendServices.resetLastUsedInferenceBackend(inferenceBackendService)
    backendServices.updateLastUsedBackend(inferenceBackendService)

    nextTick(scrollToBottom)

    let externalRagContext = null
    actualRagResults = null

    if (textInference.ragList.filter((item) => item.isChecked).length > 0) {
      try {
        // Set RAG retrieval in progress
        ragRetrievalInProgress.value = true
        showRagPreview.value = true

        // Perform RAG retrieval
        const ragResults = await textInference.embedInputUsingRag(
          question,
        )

        ragRetrievalInProgress.value = false

        if (ragResults && ragResults.length > 0) {
          externalRagContext = ragResults.map((doc) => doc.pageContent).join('\n\n')
          actualRagResults = ragResults
        }
      } catch (error) {
        console.error('Error retrieving RAG documents:', error)
      }
    }
    openAiCompatibleChat.messageInput = question
    await openAiCompatibleChat.generate()
    conversations.updateConversation(openAiCompatibleChat.messages, conversations.activeKey)
    nextTick(scrollToBottom)

  } finally {
  }
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
</script>
