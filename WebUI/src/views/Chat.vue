<template>
  <div
    v-if="conversations.activeConversation && conversations.activeConversation.length > 0 || processing"
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
      <template v-for="(chatItem, i) in conversations.activeConversation">
        <!-- eslint-enable -->
        <div class="flex items-start gap-3">
          <img :class="textInference.iconSizeClass" src="../assets/svg/user-icon.svg" />
          <div class="flex flex-col gap-3 max-w-3/4">
            <p class="text-gray-300" :class="textInference.nameSizeClass">
              {{ languages.ANSWER_USER_NAME }}
            </p>
            <div class="chat-content" style="white-space: pre-wrap">
              {{ chatItem.question }}
            </div>
            <button
              class="flex items-center gap-1 text-xs text-gray-300 mt-1"
              :title="languages.COM_COPY"
              @click="copyText(chatItem.question)"
            >
              <span class="svg-icon i-copy w-4 h-4"></span>
              <span>{{ languages.COM_COPY }}</span>
            </button>
          </div>
        </div>
        <div class="flex items-start gap-3">
          <img :class="textInference.iconSizeClass" src="../assets/svg/ai-icon.svg" />
          <div
            class="flex flex-col gap-3 bg-gray-600 rounded-md px-4 py-3 max-w-3/4 text-wrap break-words"
          >
            <div class="flex items-center gap-2">
              <p class="text-gray-300 mt-0.75" :class="textInference.nameSizeClass">
                {{ languages.ANSWER_AI_NAME }}
              </p>
              <div v-if="chatItem.model" class="flex items-center gap-2">
                  <span
                    class="bg-gray-400 text-black font-sans rounded-md px-1 py-1"
                    :class="textInference.nameSizeClass"
                  >
                    {{
                      chatItem.model.endsWith('.gguf')
                        ? (chatItem.model.split('/').at(-1)?.split('.gguf')[0] ?? chatItem.model)
                        : chatItem.model
                    }}
                  </span>
                <!-- Display RAG source if available -->
                <span
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
                  </span>
              </div>
            </div>

            <!-- RAG Source Details (collapsible) -->
            <div
              v-if="chatItem.ragSource && chatItem.showRagSource"
              class="my-2 text-gray-300 border-l-2 border-purple-400 pl-2 flex flex-row gap-1"
              :class="textInference.fontSizeClass"
            >
              <div class="font-bold">{{ i18nState.RAG_SOURCE }}:</div>
              <div class="whitespace-pre-wrap">{{ chatItem.ragSource }}</div>
            </div>
            <div class="ai-answer chat-content">
              <template v-if="chatItem.model && thinkingModels[chatItem.model]">
                <div class="mb-2 flex items-center">
                    <span class="italic text-gray-300">
                      {{
                        chatItem.reasoningTime !== undefined && chatItem.reasoningTime !== null
                          ? `Reasoned for ${
                            (chatItem.reasoningTime / 1000).toFixed(1).endsWith('.0')
                              ? (chatItem.reasoningTime / 1000).toFixed(0)
                              : (chatItem.reasoningTime / 1000).toFixed(1)
                          } seconds`
                          : 'Done Reasoning'
                      }}
                    </span>
                  <button
                    @click="chatItem.showThinkingText = !chatItem.showThinkingText"
                    class="ml-1"
                  >
                    <img
                      v-if="chatItem.showThinkingText"
                      src="../assets/svg/arrow-up.svg"
                      class="w-4 h-4"
                    />
                    <img v-else src="../assets/svg/arrow-down.svg" class="w-4 h-4" />
                  </button>
                </div>
                <div
                  v-if="chatItem.showThinkingText"
                  class="border-l-2 border-gray-400 pl-4 text-gray-300"
                  v-html="chatItem.parsedThinkingText"
                ></div>
                <div v-html="chatItem.parsedAnswer"></div>
              </template>
              <template v-else>
                <div v-html="chatItem.parsedAnswer"></div>
              </template>
            </div>
            <div class="answer-tools flex gap-3 items-center text-gray-300">
              <button
                class="flex items-end"
                :title="languages.COM_COPY"
                @click="
                    copyText(
                      chatItem.model && thinkingModels[chatItem.model]
                        ? textInference.extractPostMarker(chatItem.answer, chatItem.model)
                        : chatItem.answer,
                    )
                  "
              >
                <span class="svg-icon i-copy w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_COPY }}</span>
              </button>
              <button
                class="flex items-end"
                :title="languages.COM_REGENERATE"
                @click="() => regenerateLastResponse(conversations.activeKey)"
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
                @click="
                    () => conversations.deleteItemFromConversation(conversations.activeKey, i)
                  "
              >
                <span class="svg-icon i-delete w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_DELETE }}</span>
              </button>
            </div>
            <div
              v-if="textInference.metricsEnabled && chatItem.metrics"
              class="metrics-info text-xs text-gray-400"
            >
              <span class="mr-2">{{ chatItem.metrics.num_tokens }} Tokens</span>
              <span class="mr-2">⋅</span>
              <span class="mr-2"
              >{{ chatItem.metrics.overall_tokens_per_second.toFixed(2) }} Tokens/s</span
              >
              <span class="mr-2">⋅</span>
              <span class="mr-2"
              >1st Token Time: {{ chatItem.metrics.first_token_latency.toFixed(2) }}s</span
              >
            </div>
          </div>
        </div>
      </template>
      <div
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
            <template
              v-if="textInference.activeModel && thinkingModels[textInference.activeModel]"
            >
              <div class="mb-2 flex items-center">
                  <span class="italic text-gray-300 inline-flex items-center">
                    <template v-if="thinkingText || postMarkerText">
                      <span v-if="reasoningTotalTime !== 0" class="inline-block mr-1">
                        {{ `Reasoned for ${(reasoningTotalTime / 1000).toFixed(1)} seconds` }}
                      </span>
                      <span v-else class="inline-block w-[9ch] truncate">
                        {{ animatedReasoningText }}
                      </span>

                      <button
                        @click="showThinkingText = !showThinkingText"
                        class="flex items-center"
                      >
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
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getCurrentInstance } from 'vue'
import * as toast from "@/assets/js/toast.ts";
import { useI18N } from "@/assets/js/store/i18n.ts";
import { thinkingModels, useTextInference } from "@/assets/js/store/textInference.ts";
import { useConversations } from "@/assets/js/store/conversations.ts";
import * as util from "@/assets/js/util.ts";
import { SSEProcessor } from "@/assets/js/sseProcessor.ts";
import { useOllama } from "@/assets/js/store/ollama.ts";
import { useBackendServices } from "@/assets/js/store/backendServices.ts";
import { useGlobalSetup } from "@/assets/js/store/globalSetup.ts";
import { parse } from "@/assets/js/markdownParser.ts";
import { base64ToString } from "uint8array-extras";
import ProgressBar from "@/components/ProgressBar.vue";
import LoadingBar from "@/components/LoadingBar.vue";
import { useDialogStore } from "@/assets/js/store/dialogs.ts";

const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const textInference = useTextInference()
const conversations = useConversations()
const backendServices = useBackendServices()
const globalSetup = useGlobalSetup()
const ollama = useOllama()
const dialogStore = useDialogStore()
const processing = ref(false)
const markerFound = ref(false)
const thinkingText = ref('')
const showThinkingText = ref(false)
const postMarkerText = ref('')
const textIn = ref('')
const textOut = ref('')
const source = ref('')
const thinkOut = ref('')
const i18nState = useI18N().state
const textOutQueue = new Array<string>()
const ragRetrievalInProgress = ref(false)
const showRagPreview = ref(true)
const loadingModel = ref(false)
const autoScrollEnabled = ref(true)
const showScrollButton = ref(false)
const chatPanel = ref<HTMLElement | null>(null)

const downloadModel = reactive({
  downloading: false,
  text: '',
  percent: 0,
})

let reasoningStartTime = 0
let reasoningTotalTime = 0
let receiveOut = ''
let textOutFinish = false
let firstOutput = false
let actualRagResults: LangchainDocument[] | null = null
let sseMetrics: MetricsData | null = null
let abortController = new AbortController()

defineExpose({
  handleSubmitPromptClick,
  scrollToBottom,
  checkModelAvailability
})


// Keep track of which conversation is receiving the in-progress text
const currentlyGeneratingKey = ref<string | null>(null)


async function handleSubmitPromptClick(prompt: string) {
  const newPrompt = prompt.trim()
  if (newPrompt == '') {
    toast.error(useI18N().state.ANSWER_ERROR_NOT_PROMPT)
    return
  }
  try {
    await checkModelAvailability()

    currentlyGeneratingKey.value = conversations.activeKey

    const chatContext = JSON.parse(JSON.stringify(conversations.activeConversation))
    chatContext.push({question: newPrompt, answer: ''})
    generate(chatContext)
  } catch {
  }
}

async function checkModelAvailability() {
  // ToDo: the path for embedding downloads must be corrected and BAAI/bge-large-zh-v1.5 was accidentally downloaded to the wrong place
  return new Promise<void>(async (resolve, reject) => {
    const requiredModelDownloads =
      await textInference.getDownloadParamsForCurrentModelIfRequired('llm')
    if (textInference.ragList.length > 0) {
      const requiredEmbeddingModelDownloads =
        await textInference.getDownloadParamsForCurrentModelIfRequired('embedding')
      requiredModelDownloads.push(...requiredEmbeddingModelDownloads)
    }
    if (requiredModelDownloads.length > 0) {
      dialogStore.showDownloadDialog(requiredModelDownloads, resolve, reject)
    } else {
      resolve()
    }
  })
}

async function generate(chatContext: ChatItem[]) {
  if (textInference.backend === 'ollama') {
    ollama.generate(chatContext)
  }
  if (processing.value || chatContext.length == 0) {
    return
  }

  try {
    // Check if backend preparation is needed
    if (textInference.needsBackendPreparation) {
      textInference.startBackendPreparation()

      try {
        // Ensure backend is ready before inference
        await textInference.ensureBackendReadiness()
        // Note: completeBackendPreparation() will be called on first token
      } catch (error) {
        textInference.completeBackendPreparation() // Reset state on error
        throw error
      }
    } else {
      // Ensure backend is ready before inference (for non-preparation cases)
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

    textIn.value = util.escape2Html(chatContext[chatContext.length - 1].question)
    markerFound.value = false
    thinkingText.value = ''
    showThinkingText.value = false
    postMarkerText.value = ''
    reasoningStartTime = 0
    reasoningTotalTime = 0
    textOut.value = ''
    receiveOut = ''
    firstOutput = true
    textOutQueue.splice(0, textOutQueue.length)
    if (!abortController) {
      abortController = new AbortController()
    }
    textOutFinish = false
    processing.value = true
    nextTick(scrollToBottom)

    let externalRagContext = null
    // Reset the global actualRagResults
    actualRagResults = null

    if (textInference.ragList.filter((item) => item.isChecked).length > 0) {
      try {
        // Set RAG retrieval in progress
        ragRetrievalInProgress.value = true
        showRagPreview.value = true

        // Perform RAG retrieval
        const ragResults = await textInference.embedInputUsingRag(
          chatContext[chatContext.length - 1].question,
        )

        ragRetrievalInProgress.value = false

        if (ragResults && ragResults.length > 0) {
          externalRagContext = ragResults.map((doc) => doc.pageContent).join('\n\n')
          actualRagResults = ragResults
        }
      } catch (error) {
        // // Reset RAG retrieval status in case of error
        // ragRetrievalInProgress.value = false;

        // // Remove the temporary chat item if it exists
        // if (conversations.conversationList[currentlyGeneratingKey.value!]?.length > 0) {
        //   conversations.conversationList[currentlyGeneratingKey.value!].pop();
        // }

        console.error('Error retrieving RAG documents:', error)
      }
    }

    const requestParams = {
      device: globalSetup.modelSettings.graphics,
      prompt: chatContext,
      external_rag_context: externalRagContext,
      max_tokens: textInference.maxTokens,
      model_repo_id: textInference.activeModel,
    }

    const response = await fetch(`${textInference.currentBackendUrl}/api/llm/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestParams),
      signal: abortController.signal,
    })
    const reader = response.body!.getReader()
    await new SSEProcessor(reader, dataProcess, finishGenerate).start()
  } finally {
    processing.value = false
  }
}

const animatedReasoningText = ref('Reasoning.')
const reasoningDots = ['Reasoning.  ', 'Reasoning.. ', 'Reasoning...']
let reasoningInterval: number | null = null

watch(
  () => processing.value,
  (isProcessing) => {
    if (isProcessing && textInference.activeModel && thinkingModels[textInference.activeModel]) {
      let i = 0
      reasoningInterval = window.setInterval(() => {
        animatedReasoningText.value = reasoningDots[i % 3]
        i++
      }, 500)
    } else {
      if (reasoningInterval !== null) {
        clearInterval(reasoningInterval)
        reasoningInterval = null
      }
      animatedReasoningText.value = 'Done Reasoning'
    }
  },
)

function dataProcess(line: string) {
  console.debug(`[${util.dateFormat(new Date(), 'hh:mm:ss:fff')}] LLM data: ${line}`)

  const dataJson = line.slice(5)
  const data = JSON.parse(dataJson) as LLMOutCallback
  switch (data.type) {
    case 'text_out':
      if (reasoningStartTime === 0) {
        reasoningStartTime = performance.now()
      }

      if (data.dtype === 1) {
        const chunk = data.value
        textOutQueue.push(chunk)

        // Complete backend preparation on first token
        if (textInference.isPreparingBackend) {
          textInference.completeBackendPreparation()
        }

        const activeModel = textInference.activeModel
        if (activeModel && thinkingModels[activeModel]) {
          const currentMarker = thinkingModels[activeModel]
          if (!markerFound.value) {
            const idx = chunk.indexOf(currentMarker)
            if (idx === -1) {
              thinkingText.value += chunk
            } else {
              reasoningTotalTime = performance.now() - reasoningStartTime
              thinkingText.value += chunk.slice(0, idx)
              markerFound.value = true
              postMarkerText.value += chunk.slice(idx + currentMarker.length)
            }
          } else {
            postMarkerText.value += chunk
          }
        }
        if (firstOutput) {
          firstOutput = false
          simulatedInput()
        }
      } else {
        source.value = data.value
      }
      break
    case 'download_model_progress':
      downloadModel.downloading = true
      downloadModel.text = `${i18nState.COM_DOWNLOAD_MODEL} ${data.repo_id}\r\n${data.download_size}/${data.total_size} ${data.percent}% ${i18nState.COM_DOWNLOAD_SPEED}: ${data.speed}`
      downloadModel.percent = data.percent
      break
    case 'download_model_completed':
      downloadModel.downloading = false
      break
    case 'load_model':
      loadingModel.value = data.event == 'start'
      break
    case 'metrics':
      sseMetrics = {
        num_tokens: data.num_tokens ?? 0,
        total_time: data.total_time ?? 0,
        first_token_latency: data.first_token_latency ?? 0,
        overall_tokens_per_second: data.overall_tokens_per_second ?? 0,
        second_plus_tokens_per_second: data.second_plus_tokens_per_second ?? 0,
      }
      break
    case 'error':
      processing.value = false
      textInference.completeBackendPreparation()
      switch (data.err_type) {
        case 'not_enough_disk_space':
          toast.error(
            i18nState.ERR_NOT_ENOUGH_DISK_SPACE.replace(
              '{requires_space}',
              data.requires_space,
            ).replace('{free_space}', data.free_space),
          )
          break
        case 'download_exception':
          toast.error(i18nState.ERR_DOWNLOAD_FAILED)
          break
        case 'runtime_error':
          toast.error(i18nState.ERROR_RUNTIME_ERROR)
          break
        case 'unknown_exception':
          toast.error(i18nState.ERROR_GENERATE_UNKONW_EXCEPTION)
          break
      }
      break
  }
}

function regenerateLastResponse(conversationKey: string) {
  const item = conversations.conversationList[conversationKey].pop()
  if (!item) return
  const prompt = item.question
  const chatContext = [...toRaw(conversations.conversationList[conversationKey])]

  const finalMetrics: MetricsData = sseMetrics ?? {
    num_tokens: 0,
    total_time: 0,
    first_token_latency: 0,
    overall_tokens_per_second: 0,
    second_plus_tokens_per_second: 0,
  }

  chatContext.push({
    question: prompt,
    answer: '',
    parsedAnswer: '',
    parsedThinkingText: '',
    metrics: finalMetrics,
    createdAt: Date.now(),
  })
  currentlyGeneratingKey.value = conversationKey
  generate(chatContext)
}

async function simulatedInput() {
  while (textOutQueue.length > 0) {
    const newText = textOutQueue.shift()!
    receiveOut += newText
    if (thinkingModels[textInference.activeModel ?? '']) {
      textOut.value = await parse(
        textInference.extractPostMarker(receiveOut, textInference.activeModel),
      )
      thinkOut.value = await parse(
        textInference.extractPreMarker(receiveOut, textInference.activeModel),
      )
    } else {
      textOut.value = await parse(receiveOut)
    }
    await nextTick()

    if (autoScrollEnabled.value) {
      scrollToBottom()
    }
  }
  if (!textOutFinish) {
    await util.delay(20)
    await simulatedInput()
  } else {
    const key = currentlyGeneratingKey.value

    const finalMetrics: MetricsData = sseMetrics ?? {
      num_tokens: 0,
      total_time: 0,
      first_token_latency: 0,
      overall_tokens_per_second: 0,
      second_plus_tokens_per_second: 0,
    }

    if (key !== null) {
      const ragSourceInfo =
        actualRagResults && actualRagResults.length
          ? textInference.formatRagSources(actualRagResults)
          : null

      const thinkingOutput = thinkingModels[textInference.activeModel ?? '']
        ? textInference.extractPreMarker(receiveOut, textInference.activeModel)
        : ''

      const nonThinkingOutput = thinkingModels[textInference.activeModel ?? '']
        ? textInference.extractPostMarker(receiveOut, textInference.activeModel)
        : receiveOut

      const parsedAnswer = await parse(nonThinkingOutput)
      const parsedThinkingText = await parse(thinkingOutput)

      console.log('parsed answer', parsedAnswer)

      conversations.addToActiveConversation(key, {
        question: textIn.value,
        answer: receiveOut, // No longer append source to answer
        parsedAnswer,
        parsedThinkingText,
        metrics: finalMetrics,
        model: textInference.activeModel,
        ragSource: ragSourceInfo, // Store source separately
        showRagSource: showRagPreview.value, // Initially collapsed
        showThinkingText: false,
        reasoningTime: markerFound.value ? reasoningTotalTime : undefined,
        createdAt: Date.now(),
      })
      if (conversations.conversationList[key].length <= 3) {
        console.log('Conversations is less than 4 items long, generating new title')
        updateTitle(conversations.conversationList[key])
      }
    }

    sseMetrics = null
    processing.value = false
    textIn.value = ''
    textOut.value = ''
    nextTick(() => {
      if (!chatPanel.value) {
        return
      }

      chatPanel.value.querySelectorAll('.copy-code').forEach((item) => {
        console.log('setting copycode listeners for', item)
        const el = item as HTMLElement
        el.classList.remove('hidden')
        el.removeEventListener('click', copyCode)
        el.addEventListener('click', copyCode)
      })
      if (autoScrollEnabled.value) {
        scrollToBottom(false)
      }
    })
  }
}

async function updateTitle(conversation: ChatItem[]) {
  const instruction = `Create me a short descriptive title for the following conversation in a maximum of 4 words. Don't use unnecessary words like 'Conversation about': `
  const prompt = `${instruction}\n\n\`\`\`${JSON.stringify(conversation.slice(0, 3).map((item) => ({
    question: item.question,
    answer: item.answer
  })))}\`\`\``
  console.log('prompt', prompt)
  const chatContext = [{question: prompt, answer: ''}]
  const requestParams = {
    device: globalSetup.modelSettings.graphics,
    prompt: chatContext,
    max_tokens: 8,
    model_repo_id: textInference.activeModel,
    print_metrics: false,
  }
  const response = await fetch(`${textInference.currentBackendUrl}/api/llm/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestParams),
    signal: abortController.signal,
  })
  if (!response.body) {
    return
  }
  const reader = response.body.getReader()
  const responses: LLMOutCallback[] = []
  const getResponse = (line: string) => {
    responses.push(JSON.parse(line.slice(5)))
  }

  await new SSEProcessor(reader, getResponse, finishGenerate).start() // is finishGenerate needed here? Cannot use it because of void input

  const isTextCallback = (item: LLMOutCallback): item is LLMOutTextCallback =>
    item.type == 'text_out' && item.dtype == 1

  conversation[0].title = responses
    .filter(isTextCallback)
    .reduce((acc, item) => acc + item.value, '')
    .replace(/"/g, '')
}

function finishGenerate() {
  textOutFinish = true
}

function handleScroll(e: Event) {
  const target = e.target as HTMLElement
  const distanceFromBottom = target.scrollHeight - (target.scrollTop + target.clientHeight)

  autoScrollEnabled.value = distanceFromBottom <= 35;
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
