<!-- eslint-disable vue/no-use-v-if-with-v-for -->
<template>
  <div id="answerPanel" class="h-full flex flex-col pr-4 pb-4 relative bg-origin-padding">
    <div class="flex flex-row flex-auto overflow-y-auto">
      <div
        id="chatHistoryPanel"
        :class="{ 'w-12': !isHistoryVisible, 'w-56': isHistoryVisible }"
        class="flex flex-shrink-0 flex-col justify-between overflow-y-auto bg-gradient-to-r from-[#05010fb4]/20 to-[#05010fb4]/70 transition-all"
      >
        <div class="flex justify-end">
          <button @click="isHistoryVisible = !isHistoryVisible" class="m-2 flex text-white">
            <img
              v-if="!isHistoryVisible"
              :class="textInference.iconSizeClass"
              src="@/assets/svg/expand.svg"
              class="w-8 h-8"
            />
            <img
              v-else
              :class="textInference.iconSizeClass"
              src="@/assets/svg/collapse.svg"
              class="w-8 h-8"
            />
          </button>
        </div>
        <div class="flex flex-col-reverse">
          <div
            v-if="isHistoryVisible"
            v-for="(conversation, conversationKey) in conversations.conversationList"
            :key="'if' + conversationKey"
            @click="onConversationClick(conversationKey)"
            :title="conversation?.[0]?.title ?? languages.ANSWER_NEW_CONVERSATION"
            class="flex justify-between items-center h-12 cursor-pointer text-gray-300 p-4 hover:bg-[#00c4fa]/50"
            :class="conversations.activeKey === conversationKey ? 'bg-[#00c4fa]/50' : ''"
          >
            <span class="w-40 whitespace-nowrap overflow-x-auto text-ellipsis">{{
              conversation?.[0]?.title ?? languages.ANSWER_NEW_CONVERSATION
            }}</span>
            <span
              v-if="!conversations.isNewConversation(conversationKey)"
              @click="() => conversations.deleteConversation(conversationKey)"
              class="svg-icon i-delete w-5 h-5"
            ></span>
          </div>
          <div
            v-else
            v-for="(conversation, conversationKey) in conversations.conversationList"
            :key="'else' + conversationKey"
            :inVisibleKey="conversationKey"
            @click="onConversationClick(conversationKey)"
            :title="conversation?.[0]?.title ?? languages.ANSWER_NEW_CONVERSATION"
            class="flex justify-between items-center h-12 py-2 cursor-pointer hover:bg-[#00c4fa]/50"
            :class="conversations.activeKey === conversationKey ? 'bg-[#00c4fa]/50' : ''"
          >
            <span
              v-if="conversationKey === currentlyGeneratingKey && processing"
              class="svg-icon i-loading w-8 h-8 animate-spin text-white flex items-center justify-center m-auto"
            ></span>
            <svg
              v-else-if="conversations.isNewConversation(conversationKey)"
              class="m-auto h-8 w-8 text-gray-300"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M12 9v6m3-3H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
              />
            </svg>
            <svg
              v-else
              class="m-auto h-8 w-8 text-gray-300"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1"
                d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"
              />
            </svg>
          </div>
        </div>
      </div>
      <div
        id="chatPanel"
        class="p-4 chat-panel flex-auto flex flex-col gap-6 m-4 text-white overflow-y-scroll"
        :class="textInference.fontSizeClass"
        @scroll="handleScroll"
      >
        <!-- eslint-disable vue/require-v-for-key -->
        <template v-for="(chat, i) in conversations.activeConversation">
          <!-- eslint-enable -->
          <div class="flex items-start gap-3">
            <img :class="textInference.iconSizeClass" src="@/assets/svg/user-icon.svg" />
            <div class="flex flex-col gap-3 max-w-3/4">
              <p class="text-gray-300" :class="textInference.nameSizeClass">
                {{ languages.ANSWER_USER_NAME }}
              </p>
              <div class="chat-content" style="white-space: pre-wrap">
                {{ chat.question }}
              </div>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <img :class="textInference.iconSizeClass" src="@/assets/svg/ai-icon.svg" />
            <div
              class="flex flex-col gap-3 bg-gray-600 rounded-md px-4 py-3 max-w-3/4 text-wrap break-words"
            >
              <div class="flex items-center gap-2">
                <p class="text-gray-300 mt-0.75" :class="textInference.nameSizeClass">
                  {{ languages.ANSWER_AI_NAME }}
                </p>
                <div v-if="chat.model">
                  <span
                    class="bg-gray-400 text-black font-sans rounded-md px-1 py-1"
                    :class="textInference.nameSizeClass"
                  >
                    {{ chat.model }}
                  </span>
                </div>
              </div>
              <div
                class="ai-answer chat-content"
                v-html="markdownParser.parseMarkdown(chat.answer)"
              ></div>
              <div class="answer-tools flex gap-3 items-center text-gray-300">
                <button class="flex items-end" :title="languages.COM_COPY" @click="copyText">
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
                v-if="textInference.metricsEnabled && chat.metrics"
                class="metrics-info text-xs text-gray-400"
              >
                <span class="mr-2">{{ chat.metrics.num_tokens }} Tokens</span>
                <span class="mr-2">⋅</span>
                <span class="mr-2"
                  >{{ chat.metrics.overall_tokens_per_second.toFixed(2) }} Tokens/s</span
                >
                <span class="mr-2">⋅</span>
                <span class="mr-2"
                  >1st Token Time: {{ chat.metrics.first_token_latency.toFixed(2) }}s</span
                >
              </div>
            </div>
          </div>
        </template>
        <div
          class="flex items-start gap-3"
          v-show="processing && conversations.activeKey === currentlyGeneratingKey"
        >
          <img :class="textInference.iconSizeClass" src="@/assets/svg/user-icon.svg" />
          <div class="flex flex-col gap-3 max-w-3/4">
            <p class="text-gray-300" :class="textInference.nameSizeClass">
              {{ languages.ANSWER_USER_NAME }}
            </p>
            <div class="chat-content" style="white-space: pre-wrap">
              {{ textIn }}
            </div>
          </div>
        </div>
        <div
          class="flex items-start gap-3"
          v-show="processing && conversations.activeKey === currentlyGeneratingKey"
        >
          <img :class="textInference.iconSizeClass" src="@/assets/svg/ai-icon.svg" />
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
            </div>
            <div
              v-if="!downloadModel.downloading && !loadingModel"
              class="ai-answer cursor-block break-all"
              v-html="textOut"
            ></div>
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
    <!-- Button to scroll to bottom -->
    <button
      v-if="showScrollButton"
      class="absolute bottom-56 left-1/2 -translate-x-1/2 bg-white text-black p-2 rounded-full shadow-lg z-50"
      @click="() => scrollToBottom()"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
      </svg>
    </button>
    <div
      class="pl-4 h-48 gap-3 flex-none flex items-center justify-center relative border-t border-color-spilter pt-4"
    >
      <div class="flex flex-col gap-2 flex-auto h-full">
        <div class="flex items-center justify-between gap-5 text-white px-2">
          <div class="flex items-center">
            <drop-selector
              :array="textInference.llmModels.filter((m) => m.type === textInference.backend)"
              @change="(i) => textInference.selectModel(textInference.backend, i.name)"
              class="w-96"
            >
              <template #selected>
                <model-drop-down-item
                  :model="
                    textInference.llmModels
                      .filter((m) => m.type === textInference.backend)
                      .find((m) => m.active)
                  "
                ></model-drop-down-item>
              </template>
              <template #list="slotItem">
                <model-drop-down-item :model="slotItem.item"></model-drop-down-item>
              </template>
            </drop-selector>
            <button
              class="svg-icon i-generate-add w-6 h-6 text-purple-500 ml-1.5"
              @click="addLLMModel"
            ></button>
            <button
              class="svg-icon i-refresh w-5 h-5 text-purple-500 flex-none ml-1"
              @animationend="removeRonate360"
              @click="refreshLLMModles"
            ></button>
            <!-- <button
                class="flex items-center flex-none justify-center gap-2 border border-white rounded-md text-sm px-4 py-1 ml-6"
                @click="() => conversations.clearConversation(conversations.activeKey)">
                <span class="svg-icon i-clear w-4 h-4"></span>
                <span>{{ languages.ANSWER_ERROR_CLEAR_SESSION }}</span>
            </button> -->
            <button
              class="flex items-center flex-none justify-center gap-2 border border-white rounded-md text-sm px-4 py-1 ml-2"
              @click="textInference.increaseFontSize"
              :disabled="textInference.isMaxSize"
              :class="{ 'opacity-50 cursor-not-allowed': textInference.isMaxSize }"
            >
              <span class="svg-icon i-zoom-in w-4 h-4"></span>
              <span>{{ languages.INCREASE_FONT_SIZE }}</span>
            </button>
            <button
              class="flex items-center flex-none justify-center gap-2 border border-white rounded-md text-sm px-4 py-1 ml-2"
              @click="textInference.decreaseFontSize"
              :disabled="textInference.isMinSize"
              :class="{ 'opacity-50 cursor-not-allowed': textInference.isMinSize }"
            >
              <span class="svg-icon i-zoom-out w-4 h-4"></span>
              <span>{{ languages.DECREASE_FONT_SIZE }}</span>
            </button>
          </div>
          <div
            v-show="textInference.backend !== 'llamaCPP'"
            class="flex justify-center items-center gap-2"
          >
            <div class="v-checkbox flex-none" type="button" :disabled="processing">
              <button
                v-show="!ragData.processEnable"
                class="v-checkbox-control flex-none"
                :class="{ 'v-checkbox-checked': ragData.enable }"
                @click="toggleRag(!ragData.enable)"
              ></button>
              <span
                v-show="ragData.processEnable"
                class="w-4 h-4 svg-icon i-loading flex-none"
              ></span>
              <label class="v-checkbox-label">{{ languages.ANSWER_RAG_ENABLE }}</label>
            </div>
            <button
              class="flex items-center justify-center flex-none gap-2 border border-white rounded-md text-sm px-4 py-1"
              @click="ragData.showUploader = true"
              :disabled="!ragData.enable || processing"
            >
              <span class="svg-icon i-upload w-4 h-4"></span>
              <span>{{ languages.ANSWER_RAG_OPEN_DIALOG }}</span>
            </button>
            <drop-selector
              :array="globalSetup.models.embedding"
              @change="changeEmbeddingModel"
              :disabled="ragData.enable || processing"
              class="w-96"
            >
              <template #selected>
                <div class="flex gap-2 items-center overflow-hidden text-ellipsis">
                  <span class="rounded-full bg-green-500 w-2 h-2"></span>
                  <span>{{ globalSetup.modelSettings.embedding }}</span>
                </div>
              </template>
              <template #list="slotItem">
                <div class="flex gap-2 items-center text-ellipsis" :title="slotItem.item">
                  <span class="rounded-full bg-green-500 w-2 h-2"></span>
                  <span class="h-7 overflow-hidden">{{ slotItem.item }}</span>
                </div>
              </template>
            </drop-selector>
          </div>
        </div>
        <textarea
          class="rounded-xl border border-color-spilter flex-auto h-full resize-none"
          :placeholder="languages.COM_LLM_PROMPT"
          v-model="question"
          @keydown="fastGenerate"
        ></textarea>
      </div>
      <div class="flex flex-col items-center gap-2 self-stretch w-24 flex-none">
        <button
          class="gernate-btn self-stretch flex flex-col flex-auto"
          @click="newPromptGenerate"
          v-show="!processing"
        >
          <span class="svg-icon i-generate-add w-8 h-8"></span>
          <span>{{ languages.COM_GENERATE }}</span>
        </button>
        <button
          class="gernate-btn self-stretch flex flex-col flex-auto"
          @click="stopGenerate"
          v-show="processing"
        >
          <span
            class="svg-icon w-7 h-7"
            :class="{ 'i-stop': !stopping, 'i-loading': stopping }"
          ></span>
          <span>{{ languages.COM_GENERATE }}</span>
        </button>
      </div>
      <rag
        v-if="ragData.showUploader && textInference.backend !== 'llamaCPP'"
        ref="ragPanel"
        @close="ragData.showUploader = false"
      ></rag>
    </div>
  </div>
</template>
<script setup lang="ts">
import Rag from '../components/Rag.vue'
import ProgressBar from '../components/ProgressBar.vue'
import LoadingBar from '../components/LoadingBar.vue'
import DropSelector from '@/components/DropSelector.vue'
import ModelDropDownItem from '@/components/ModelDropDownItem.vue'
import { useI18N } from '@/assets/js/store/i18n'
import * as toast from '@/assets/js/toast'
import * as util from '@/assets/js/util'
import { SSEProcessor } from '@/assets/js/sseProcessor'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useModels } from '@/assets/js/store/models'
import { MarkdownParser } from '@/assets/js/markdownParser'
import 'highlight.js/styles/github-dark.min.css'
import * as Const from '@/assets/js/const'
import { useConversations } from '@/assets/js/store/conversations'
import { LlmBackend, useTextInference } from '@/assets/js/store/textInference'
import { useBackendServices } from '@/assets/js/store/backendServices'

const conversations = useConversations()
const models = useModels()
const globalSetup = useGlobalSetup()
const backendServices = useBackendServices()
const textInference = useTextInference()
const i18nState = useI18N().state
const question = ref('')
const processing = ref(false)
let textOutFinish = false
let abortController = new AbortController()
const textOutQueue = new Array<string>()
const textIn = ref('')
const textOut = ref('')
let firstOutput = false
const ragPanel = ref<InstanceType<typeof Rag>>()
const downloadModel = reactive({
  downloading: false,
  text: '',
  percent: 0,
})
const loadingModel = ref(false)
let receiveOut = ''
let chatPanel: HTMLElement
const markdownParser = new MarkdownParser(i18nState.COM_COPY)
const ragData = reactive({
  enable: false,
  processEnable: false,
  showUploader: false,
})

let sseMetrics: MetricsData | null = null

const source = ref('')
const emits = defineEmits<{
  (
    e: 'showDownloadModelConfirm',
    downloadList: DownloadModelParam[],
    success?: () => void,
    fail?: () => void,
  ): void
  (e: 'showModelRequest', success?: () => void, fail?: () => void): void
}>()

let abortContooler: AbortController | null
const stopping = ref(false)

const isHistoryVisible = ref(false)

// Keep track of which conversation is receiving the in-progress text
const currentlyGeneratingKey = ref<string | null>(null)
const showScrollButton = ref(false)

onMounted(async () => {
  chatPanel = document.getElementById('chatPanel')!
})

function finishGenerate() {
  textOutFinish = true
}

function dataProcess(line: string) {
  console.log(`[${util.dateFormat(new Date(), 'hh:mm:ss:fff')}] LLM data: ${line}`)

  const dataJson = line.slice(5)
  const data = JSON.parse(dataJson) as LLMOutCallback
  switch (data.type) {
    case 'text_out':
      if (data.dtype == 1) {
        const text = firstOutput ? data.value : data.value //.replace(/<[^>]+>/g, "");
        textOutQueue.push(text)
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
        case 'unknow_exception':
          toast.error(i18nState.ERROR_GENERATE_UNKONW_EXCEPTION)
          break
      }
      break
  }
}

function handleScroll(e: Event) {
  const target = e.target as HTMLElement
  const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 50
  showScrollButton.value = !atBottom
}

function scrollToBottom(smooth = true) {
  chatPanel.scrollTo({
    top: chatPanel.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto',
  })
}

function onConversationClick(conversationKey: string) {
  console.log('Switching to conversationKey:', conversationKey)
  conversations.activeKey = conversationKey
  nextTick(() => {
    scrollToBottom(false)
  })
}

async function updateTitle(conversation: ChatItem[]) {
  const instruction = `Create me a short descriptive title for the following conversation in a maximum of 4 words. Don't use unnecessary words like 'Conversation about': `
  const prompt = `${instruction}\n\n\`\`\`${JSON.stringify(conversation.slice(0, 3).map((item) => ({ question: item.question, answer: item.answer })))}\`\`\``
  console.log('prompt', prompt)
  const chatContext = [{ question: prompt, answer: '' }]
  const requestParams = {
    device: globalSetup.modelSettings.graphics,
    prompt: chatContext,
    enable_rag: false,
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
  const newTitle = responses
    .filter(isTextCallback)
    .reduce((acc, item) => acc + item.value, '')
    .replace(/"/g, '')
  conversation[0].title = newTitle
}

async function simulatedInput() {
  while (textOutQueue.length > 0) {
    const newText = textOutQueue.shift()!
    receiveOut += newText
    // textOut.value = receiveOut;
    textOut.value = markdownParser.parseMarkdown(receiveOut)
    await nextTick()
    scrollToBottom()
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
      conversations.addToActiveConversation(key, {
        question: textIn.value,
        answer:
          ragData.enable && source.value != ''
            ? `${receiveOut}\r\n\r\n${i18nState.RAG_SOURCE}${source.value}`
            : receiveOut,
        metrics: finalMetrics,
        model: textInference.activeModel,
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
      chatPanel.querySelectorAll('copy-code').forEach((item) => {
        const el = item as HTMLElement
        el.removeEventListener('click', copyCode)
        el.addEventListener('click', copyCode)
      })
      scrollToBottom(false)
    })
  }
}

function fastGenerate(e: KeyboardEvent) {
  if (e.code == 'Enter') {
    if (processing.value) {
      return
    }

    if (e.ctrlKey || e.shiftKey || e.altKey) {
      question.value += '\n'
    } else {
      e.preventDefault()
      if (question.value !== '') {
        newPromptGenerate()
      }
    }
  }
}

async function newPromptGenerate() {
  const newPrompt = question.value.trim()
  if (newPrompt == '') {
    toast.error(useI18N().state.ANSWER_ERROR_NOT_PROMPT)
    return
  }
  try {
    await checkModelAvailability()

    // Mark which conversation is about to generate
    currentlyGeneratingKey.value = conversations.activeKey

    const chatContext = JSON.parse(JSON.stringify(conversations.activeConversation))
    chatContext.push({ question: newPrompt, answer: '' })
    generate(chatContext)
    question.value = ''
  } catch {}
}

async function checkModelAvailability() {
  return new Promise<void>(async (resolve, reject) => {
    const requiredModelDownloads = await textInference.getDownloadParamsForCurrentModelIfRequired()
    if (requiredModelDownloads.length > 0) {
      emits('showDownloadModelConfirm', requiredModelDownloads, resolve, reject)
    } else {
      resolve()
    }
  })
}

async function generate(chatContext: ChatItem[]) {
  if (processing.value || chatContext.length == 0) {
    return
  }

  try {
    const backendToInferenceService: Record<LlmBackend, BackendServiceName> = {
      llamaCPP: 'llamacpp-backend',
      openVINO: 'openvino-backend',
      ipexLLM: 'ai-backend',
    }
    const inferenceBackendService = backendToInferenceService[textInference.backend]
    await backendServices.resetLastUsedInferenceBackend(inferenceBackendService)
    backendServices.updateLastUsedBackend(inferenceBackendService)

    textIn.value = util.escape2Html(chatContext[chatContext.length - 1].question)
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
    const requestParams = {
      device: globalSetup.modelSettings.graphics,
      prompt: chatContext,
      enable_rag: ragData.enable && textInference.backend === 'ipexLLM',
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

async function stopGenerate() {
  if (processing.value && !stopping.value) {
    stopping.value = true
    await fetch(`${textInference.currentBackendUrl}/api/llm/stopGenerate`)
    if (abortContooler) {
      abortContooler.abort()
      abortContooler = null
    }
    processing.value = false
    stopping.value = false
  }
}

function copyText(e: Event) {
  const target = e.target as HTMLElement
  if (target) {
    util.copyText(
      (target.parentElement!.parentElement!.previousElementSibling! as HTMLElement).innerText,
    )
  }
}

function removeRonate360(ev: AnimationEvent) {
  const target = ev.target as HTMLElement
  target.classList.remove('animate-ronate360')
}

async function addLLMModel() {
  return new Promise<void>(async (resolve, reject) => {
    emits('showModelRequest', resolve, reject)
  })
}

async function refreshLLMModles(e: Event) {
  const button = e.target as HTMLElement
  button.classList.add('animate-ronate360')
  await models.refreshModels()
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
    metrics: finalMetrics,
  })
  currentlyGeneratingKey.value = conversationKey
  generate(chatContext)
}

function copyCode(e: MouseEvent) {
  let target: HTMLElement | null = e.target as HTMLElement
  while (target && target != chatPanel) {
    target = target.parentElement
    if (target && target.classList.contains('code-section')) {
      const codeHtmlEl = target.querySelector('.code-content>pre') as HTMLElement
      if (codeHtmlEl) {
        util.copyText(codeHtmlEl.innerText)
        toast.success(i18nState.COM_COPY_SUCCESS_TIP)
        return
      }
    }
  }
}

function changeEmbeddingModel(item: unknown, _: number) {
  globalSetup.applyModelSettings({ embedding: item as string })
}

async function toggleRag(value: boolean) {
  if (ragData.processEnable) {
    return
  }
  ragData.processEnable = true
  try {
    if (value) {
      const checkList: CheckModelAlreadyLoadedParameters[] = [
        {
          repo_id: globalSetup.modelSettings.embedding,
          type: Const.MODEL_TYPE_EMBEDDING,
          backend: 'default',
        },
      ]
      if (!(await models.checkModelAlreadyLoaded(checkList))[0].already_loaded) {
        emits('showDownloadModelConfirm', checkList, enableRag, () => {
          ragData.processEnable = false
        })
      } else {
        await enableRag()
      }
    } else {
      await disableRag()
      ragData.enable = false
    }
  } finally {
    ragData.processEnable = false
  }
}

async function enableRag() {
  const formData = new FormData()
  formData.append('repo_id', globalSetup.modelSettings.embedding)
  formData.append('device', globalSetup.modelSettings.graphics)
  try {
    await fetch(`${globalSetup.apiHost}/api/llm/enableRag`, {
      method: 'POST',
      body: formData,
    })
    ragData.enable = true
  } catch (e) {
    console.error(`Enabling rag failed due to ${e}`)
  }
}

async function disableRag() {
  try {
    await fetch(`${globalSetup.apiHost}/api/llm/disableRag`)
  } catch (e) {
    console.error(`Disabling rag failed due to ${e}`)
  }
}

watch(
  () => textInference.backend,
  (newBackend, _oldBackend) => {
    if (newBackend === 'ipexLLM') {
      restoreRagState()
    } else {
      disableRag()
    }
  },
)

async function restoreRagState() {
  ragData.processEnable = true
  if (ragData.enable) {
    await enableRag()
  } else {
    await disableRag()
  }
  ragData.processEnable = false
}

defineExpose({
  checkModel: checkModelAvailability,
  restoreRagState,
  disableRag,
})
</script>
