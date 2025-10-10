<template>
  <div id="new-ui" class="text-white flex flex-col items-center justify-center gap-7 text-base">
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
          @click="currentMode = 'chat'"
          :class="currentMode === 'chat' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600'"
          class="px-3 py-1.5 rounded-lg text-sm"
        >
          Chat
        </button>
        <button
          @click="currentMode = 'imageGen'"
          :class="currentMode === 'imageGen' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600'"
          class="px-3 py-1.5 rounded-lg text-sm"
        >
          Image Gen
        </button>
        <button
          @click="currentMode = 'imageEdit'"
          :class="currentMode === 'imageEdit' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600'"
          class="px-3 py-1.5 rounded-lg text-sm"
        >
          Image Edit
        </button>
        <button
          @click="currentMode = 'video'"
          :class="currentMode === 'video' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600'"
          class="px-3 py-1.5 rounded-lg text-sm"
        >
          Video
        </button>
      </div>

      <div class="absolute bottom-3 right-3 flex gap-2">
        <button class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm">
          Button 5
        </button>
        <button
          @click="handleSubmitPromptClick"
          class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm">
          →
        </button>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import {getCurrentInstance} from 'vue'
import * as toast from "@/assets/js/toast.ts";
import {useI18N} from "@/assets/js/store/i18n.ts";
import {thinkingModels, useTextInference} from "@/assets/js/store/textInference.ts";
import {useConversations} from "@/assets/js/store/conversations.ts";
import * as util from "@/assets/js/util.ts";
import {SSEProcessor} from "@/assets/js/sseProcessor.ts";
import {useOllama} from "@/assets/js/store/ollama.ts";
import {useBackendServices} from "@/assets/js/store/backendServices.ts";
import {useGlobalSetup} from "@/assets/js/store/globalSetup.ts";
import {parse} from "@/assets/js/markdownParser.ts";
import {base64ToString} from "uint8array-extras";

const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const textInference = useTextInference()
const conversations = useConversations()
const backendServices = useBackendServices()
const globalSetup = useGlobalSetup()
const ollama = useOllama()
const question = ref('')
const processing = ref(false)
const currentMode = ref('chat')
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
let chatPanel: HTMLElement
let sseMetrics: MetricsData | null = null

// todo: wtf is this?
// let abortContooler: AbortController | null
let abortController = new AbortController()

const emits = defineEmits<{
  (
    e: 'showDownloadModelConfirm',
    downloadList: DownloadModelParam[],
    success?: () => void,
    fail?: () => void,
  ): void
  (e: 'showModelRequest', success?: () => void, fail?: () => void): void
}>()

// Keep track of which conversation is receiving the in-progress text
const currentlyGeneratingKey = ref<string | null>(null)

onMounted(async () => {
  chatPanel = document.getElementById('chatPanel')!
})

// todo: New abbreviations are likely wrong
// todo: Languages other than en-US need to be added
function getTextAreaPlaceholder() {
  switch (currentMode.value) {
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

async function handleSubmitPromptClick() {
  const newPrompt = question.value.trim()
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
    question.value = ''
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
      emits('showDownloadModelConfirm', requiredModelDownloads, resolve, reject)
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
      chatPanel.querySelectorAll('.copy-code').forEach((item) => {
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

function scrollToBottom(smooth = true) {
  chatPanel.scrollTo({
    top: chatPanel.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto',
  })
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

function fastGenerate(e: KeyboardEvent) {
  console.log(e.key)

  // if (e.code == 'Enter') {
  //   if (processing.value) {
  //     return
  //   }
  //
  //   if (e.ctrlKey || e.shiftKey || e.altKey) {
  //     question.value += '\n'
  //   } else {
  //     e.preventDefault()
  //     if (question.value !== '') {
  //       newPromptGenerate()
  //     }
  //   }
  // }
}

onMounted(() => {
  document
    .getElementById('new-ui')!
    .querySelectorAll('a')
    .forEach((item) => {
      item.addEventListener('click', function (e) {
        e.preventDefault()
        window.electronAPI.openUrl(this.href as string)
        return false
      })
    })
})
</script>
