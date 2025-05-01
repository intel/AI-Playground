<!-- eslint-disable vue/no-use-v-if-with-v-for -->
<template>
  <div id="answerPanel" class="h-full flex flex-col pr-4 pb-4 relative bg-origin-padding">
    <div class="flex flex-row flex-auto overflow-y-auto">
      <div
        id="chatHistoryPanel"
        :class="{ 'w-12': !isHistoryVisible, 'w-56': isHistoryVisible }"
        class="flex flex-shrink-0 flex-col overflow-y-auto bg-gradient-to-r from-[#05010fb4]/20 to-[#05010fb4]/70 transition-all"
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
            class="group relative cursor-pointer text-gray-300"
          >
            <div class="flex justify-between items-center w-full h-10 px-3">
              <div
                v-if="conversations.activeKey === conversationKey"
                class="absolute inset-1 bg-[#00c4fa]/50 rounded-lg"
              ></div>
              <div class="relative flex justify-between items-center w-full">
                <span class="w-45 whitespace-nowrap overflow-x-auto text-ellipsis text-sm ml-1">
                  {{ conversation?.[0]?.title ?? languages.ANSWER_NEW_CONVERSATION }}
                </span>
                <span
                  v-if="!conversations.isNewConversation(conversationKey)"
                  @click.stop="conversations.deleteConversation(conversationKey)"
                  class="text-3xl opacity-0 group-hover:opacity-70 transition-opacity duration-200 cursor-pointer ml-3"
                >
                  ×
                </span>
              </div>
            </div>
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
              <button
                class="flex items-center gap-1 text-xs text-gray-300 mt-1"
                :title="languages.COM_COPY"
                @click="copyText(chat.question)"
              >
                <span class="svg-icon i-copy w-4 h-4"></span>
                <span>{{ languages.COM_COPY }}</span>
              </button>
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
                <div v-if="chat.model" class="flex items-center gap-2">
                  <span
                    class="bg-gray-400 text-black font-sans rounded-md px-1 py-1"
                    :class="textInference.nameSizeClass"
                  >
                    {{ chat.model }}
                  </span>
                  <!-- Display RAG source if available -->
                  <span
                    v-if="chat.ragSource"
                    @click="chat.showRagSource = !chat.showRagSource"
                    class="bg-purple-400 text-black font-sans rounded-md px-1 py-1 cursor-pointer"
                    :class="textInference.nameSizeClass"
                  >
                    Source Docs
                    <button class="ml-1">
                      <img
                        v-if="chat.showRagSource"
                        src="@/assets/svg/arrow-up.svg"
                        class="w-3 h-3"
                      />
                      <img v-else src="@/assets/svg/arrow-down.svg" class="w-3 h-3" />
                    </button>
                  </span>
                </div>
              </div>

              <!-- RAG Source Details (collapsible) -->
              <div
                v-if="chat.ragSource && chat.showRagSource"
                class="my-2 text-gray-300 border-l-2 border-purple-400 pl-2 flex flex-row gap-1"
                :class="textInference.fontSizeClass"
              >
                <div class="font-bold">{{ i18nState.RAG_SOURCE }}:</div>
                <div class="whitespace-pre-wrap">{{ chat.ragSource }}</div>
              </div>
              <div class="ai-answer chat-content">
                <template v-if="chat.model && thinkingModels[chat.model]">
                  <div class="mb-2 flex items-center">
                    <span class="italic text-gray-300">
                      {{
                        chat.reasoningTime !== undefined && chat.reasoningTime !== null
                          ? `Reasoned for ${
                              (chat.reasoningTime / 1000).toFixed(1).endsWith('.0')
                                ? (chat.reasoningTime / 1000).toFixed(0)
                                : (chat.reasoningTime / 1000).toFixed(1)
                            } seconds`
                          : 'Done Reasoning'
                      }}
                    </span>
                    <button @click="chat.showThinkingText = !chat.showThinkingText" class="ml-1">
                      <img
                        v-if="chat.showThinkingText"
                        src="@/assets/svg/arrow-up.svg"
                        class="w-4 h-4"
                      />
                      <img v-else src="@/assets/svg/arrow-down.svg" class="w-4 h-4" />
                    </button>
                  </div>
                  <div
                    v-if="chat.showThinkingText"
                    class="border-l-2 border-gray-400 pl-4 whitespace-pre-wrap text-gray-300"
                    v-html="markdownParser.parseMarkdown(extractPreMarker(chat.answer))"
                  ></div>
                  <div
                    class="mt-2 text-white whitespace-pre-wrap"
                    v-html="markdownParser.parseMarkdown(extractPostMarker(chat.answer))"
                  ></div>
                </template>
                <template v-else>
                  <span v-html="markdownParser.parseMarkdown(chat.answer)"></span>
                </template>
              </div>
              <div class="answer-tools flex gap-3 items-center text-gray-300">
                <button
                  class="flex items-end"
                  :title="languages.COM_COPY"
                  @click="
                    copyText(
                      chat.model && thinkingModels[chat.model]
                        ? extractPostMarker(chat.answer)
                        : chat.answer,
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
              <span
                v-if="ragRetrievalInProgress || actualRagResults?.length"
                class="bg-purple-400 text-black font-sans rounded-md px-1 py-1 cursor-pointer"
                :class="textInference.nameSizeClass"
                @click="showRagPreview = !showRagPreview"
              >
                Source Docs
                <button class="ml-1">
                  <img v-if="showRagPreview" src="@/assets/svg/arrow-up.svg" class="w-3 h-3" />
                  <img v-else src="@/assets/svg/arrow-down.svg" class="w-3 h-3" />
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
                {{ getRagSources(actualRagResults) }}
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
                          src="@/assets/svg/arrow-up.svg"
                          class="w-4 h-4"
                        />
                        <img v-else src="@/assets/svg/arrow-down.svg" class="w-4 h-4" />
                      </button>
                    </template>
                    <template v-else>
                      <span class="cursor-block"></span>
                    </template>
                  </span>
                </div>
                <div
                  v-if="showThinkingText"
                  class="border-l-2 border-gray-400 pl-4 whitespace-pre-wrap text-gray-300"
                  v-html="markdownParser.parseMarkdown(thinkingText)"
                ></div>
                <div
                  class="mt-2 text-white whitespace-pre-wrap"
                  v-html="markdownParser.parseMarkdown(postMarkerText)"
                ></div>
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
      <rag v-if="showUploader" ref="ragPanel" @close="showUploader = false"></rag>
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
      class="pl-4 pt-4 flex flex-col items-center justify-center relative border-t border-color-spilter px-2"
    >
      <div class="w-full flex flex-wrap items-center gap-y-2 gap-x-4 text-white">
        <div class="flex items-center gap-2">
          <drop-down-new
            title="Inference Backend"
            @change="(item) => (textInference.backend = item as LlmBackend)"
            :value="textInference.backend"
            :items="
              [...llmBackendTypes].map((item) => ({
                label: textInferenceBackendDisplayName[item],
                value: item,
                active: isRunning(item),
              }))
            "
          ></drop-down-new>
          <drop-down-new
            title="Text Inference Model"
            @change="(item) => textInference.selectModel(textInference.backend, item)"
            :value="
              textInference.llmModels
                .filter((m) => m.type === textInference.backend)
                .find((m) => m.active)?.name ?? ''
            "
            :items="
              textInference.llmModels
                .filter((m) => m.type === textInference.backend)
                .map((item) => ({
                  label: item.name.split('/').at(-1) ?? item.name,
                  value: item.name,
                  active: item.downloaded,
                }))
            "
          ></drop-down-new>
          <button @click="addLLMModel">
            <PlusIcon class="size-6 text-purple-500"></PlusIcon>
          </button>
          <button @click="models.refreshModels">
            <ArrowPathIcon class="size-5 text-purple-500"></ArrowPathIcon>
          </button>
        </div>
        <div class="flex items-center gap-2">
          <label class="text-white whitespace-nowrap">{{ languages.ANSWER_METRICS }}</label>
          <button
            class="v-checkbox-control flex-none w-5 h-5"
            :class="{ 'v-checkbox-checked': textInference.metricsEnabled }"
            @click="textInference.toggleMetrics()"
          ></button>
        </div>
        <div class="flex items-center gap-2">
          <label class="text-white whitespace-nowrap">{{ languages.ANSWER_MAX_TOKENS }}</label>
          <input
            type="number"
            v-model="textInference.maxTokens"
            min="0"
            max="4096"
            step="1"
            class="rounded text-white text-center h-7 w-20 leading-7 p-0 bg-transparent border border-white"
          />
        </div>

        <div class="flex items-center gap-2">
          <label class="text-white whitespace-nowrap">{{ languages.ANSWER_FONT_SIZE }}</label>
          <button
            class="flex items-center flex-none justify-center gap-2 border border-white rounded-md text-sm px-2 py-1"
            @click="textInference.increaseFontSize"
            :disabled="textInference.isMaxSize"
            :class="{ 'opacity-50 cursor-not-allowed': textInference.isMaxSize }"
          >
            <span class="svg-icon i-zoom-in w-4 h-4"></span>
          </button>
          <button
            class="flex items-center flex-none justify-center gap-2 border border-white rounded-md text-sm px-2 py-1"
            @click="textInference.decreaseFontSize"
            :disabled="textInference.isMinSize"
            :class="{ 'opacity-50 cursor-not-allowed': textInference.isMinSize }"
          >
            <span class="svg-icon i-zoom-out w-4 h-4"></span>
          </button>
        </div>
        <div class="flex items-center gap-2">
          <!-- <div class="v-checkbox flex-none" type="button" :disabled="processing">
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
          </div> -->
          <button
            class="flex items-center justify-center flex-none gap-2 border border-white rounded-md text-sm px-4 py-1"
            @click="showUploader = !showUploader"
            :disabled="processing"
            :title="languages.ANSWER_RAG_OPEN_DIALOG"
          >
            <span class="w-4 h-4 svg-icon i-rag flex-none"></span
            ><span>{{ documentButtonText }}</span>
          </button>
          <drop-down-new
            :title="languages.RAG_DOCUMENT_EMBEDDING_MODEL"
            @change="(item) => textInference.selectEmbeddingModel(textInference.backend, item)"
            :value="
              textInference.llmEmbeddingModels
                .filter((m) => m.type === textInference.backend)
                .find((m) => m.active)?.name ?? ''
            "
            :items="
              textInference.llmEmbeddingModels
                .filter((m) => m.type === textInference.backend)
                .map((item) => ({
                  label: item.name.split('/').at(-1) ?? item.name,
                  value: item.name,
                  active: item.downloaded,
                }))
            "
          ></drop-down-new>
        </div>
      </div>
      <div class="w-full h-32 gap-3 flex-none flex items-center pt-2">
        <textarea
          class="rounded-xl border border-color-spilter flex-auto h-full resize-none"
          :placeholder="languages.COM_LLM_PROMPT"
          v-model="question"
          @keydown="fastGenerate"
        ></textarea>
        <button
          class="gernate-btn self-stretch flex flex-col w-32 flex-none"
          v-if="!processing"
          @click="newPromptGenerate"
        >
          <span class="svg-icon i-generate-add w-7 h-7"></span>
          <span>{{ languages.COM_GENERATE }}</span>
        </button>
        <button
          class="gernate-btn self-stretch flex flex-col w-32 flex-none"
          v-if="processing"
          @click="stopGenerate"
        >
          <span
            class="svg-icon w-7 h-7"
            :class="{ 'i-stop': !stopping, 'i-loading': stopping }"
          ></span>
          <span>{{ languages.COM_STOP }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import Rag from '../components/Rag.vue'
import ProgressBar from '../components/ProgressBar.vue'
import LoadingBar from '../components/LoadingBar.vue'
import { useI18N } from '@/assets/js/store/i18n'
import * as toast from '@/assets/js/toast'
import * as util from '@/assets/js/util'
import { SSEProcessor } from '@/assets/js/sseProcessor'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useModels } from '@/assets/js/store/models'
import { MarkdownParser } from '@/assets/js/markdownParser'
import 'highlight.js/styles/github-dark.min.css'
import DropDownNew from '@/components/DropDownNew.vue'
import { useConversations } from '@/assets/js/store/conversations'
import { llmBackendTypes, LlmBackend, useTextInference } from '@/assets/js/store/textInference'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { PlusIcon, ArrowPathIcon } from '@heroicons/vue/24/solid'

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
const showUploader = ref(false)
const downloadModel = reactive({
  downloading: false,
  text: '',
  percent: 0,
})
const loadingModel = ref(false)
const ragRetrievalInProgress = ref(false)
const showRagPreview = ref(true)
let receiveOut = ''
let chatPanel: HTMLElement
const markdownParser = new MarkdownParser(i18nState.COM_COPY)

const thinkingModels: Record<string, string> = {
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B': '</think>\n\n',
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B': '</think>\n\n',
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-1.5B-int4-ov': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-7B-int4-ov': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-14B-int4-ov': '</think>\n\n',
}

const markerFound = ref(false)
const thinkingText = ref('')
const showThinkingText = ref(false)
const postMarkerText = ref('')

let reasoningStartTime = 0
let reasoningTotalTime = 0

function extractPreMarker(fullAnswer: string): string {
  const model = textInference.activeModel
  if (model && thinkingModels[model]) {
    const marker = thinkingModels[model]
    const idx = fullAnswer.indexOf(marker)
    return idx === -1 ? fullAnswer : fullAnswer.slice(0, idx)
  }
  return fullAnswer
}

function extractPostMarker(fullAnswer: string): string {
  const model = textInference.activeModel
  if (model && thinkingModels[model]) {
    const marker = thinkingModels[model]
    const idx = fullAnswer.indexOf(marker)
    return idx === -1 ? '' : fullAnswer.slice(idx + marker.length)
  }
  return ''
}

let sseMetrics: MetricsData | null = null
let actualRagResults: LangchainDocument[] | null = null

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
const autoScrollEnabled = ref(true)

onMounted(async () => {
  chatPanel = document.getElementById('chatPanel')!
})

function finishGenerate() {
  textOutFinish = true
}

// A friendly display name for each backend
const textInferenceBackendDisplayName: Record<LlmBackend, string> = {
  ipexLLM: 'IPEX-LLM',
  llamaCPP: 'llamaCPP - GGUF',
  openVINO: 'OpenVINO',
}

// Optional: if you want to show whether each backend is currently running
function mapBackendNames(name: LlmBackend): BackendServiceName | undefined {
  if (name === 'ipexLLM') return 'ai-backend'
  if (name === 'llamaCPP') return 'llamacpp-backend'
  if (name === 'openVINO') return 'openvino-backend'
  return undefined
}
function isRunning(name: LlmBackend) {
  const backendName = mapBackendNames(name)
  return backendServices.info.find((item) => item.serviceName === backendName)?.status === 'running'
}

const animatedReasoningText = ref('Reasoning.')
const reasoningDots = ['Reasoning.  ', 'Reasoning.. ', 'Reasoning...']
let reasoningInterval: number | null = null

// Computed properties for document stats and button text
const documentStats = computed(() => {
  const totalDocs = textInference.ragList.length
  const enabledDocs = textInference.ragList.filter((doc) => doc.isChecked).length
  return { total: totalDocs, enabled: enabledDocs }
})

const documentButtonText = computed(() => {
  const stats = documentStats.value
  if (stats.total === 0) {
    return 'Add Documents'
  } else {
    return `${i18nState.RAG_DOCUMENTS} (${stats.enabled}/${stats.total} ${i18nState.RAG_ENABLED})`
  }
})

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

function handleScroll(e: Event) {
  const target = e.target as HTMLElement
  const distanceFromBottom = target.scrollHeight - (target.scrollTop + target.clientHeight)

  if (distanceFromBottom > 35) {
    autoScrollEnabled.value = false
  } else {
    autoScrollEnabled.value = true
  }
  showScrollButton.value = distanceFromBottom > 60
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
    textOut.value = markdownParser.parseMarkdown(receiveOut)
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
        actualRagResults && actualRagResults.length ? getRagSources(actualRagResults) : null

      conversations.addToActiveConversation(key, {
        question: textIn.value,
        answer: receiveOut, // No longer append source to answer
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
      chatPanel.querySelectorAll('copy-code').forEach((item) => {
        const el = item as HTMLElement
        el.removeEventListener('click', copyCode)
        el.addEventListener('click', copyCode)
      })
      if (autoScrollEnabled.value) {
        scrollToBottom(false)
      }
    })
  }
}

function getRagSources(actualRagResults: LangchainDocument[]): string {
  // Group documents by source file
  const fileGroups = new Map<
    string,
    Array<{
      lines?: { from: number; to: number }
      page?: number
    }>
  >()
  const unknownSources: string[] = []

  // Process each document
  actualRagResults.forEach((doc) => {
    const source = doc.metadata?.source
    const location = doc.metadata.loc as
      | { pageNumber?: number; lines?: { from?: number; to?: number } }
      | undefined

    // Handle unknown sources
    if (!source) {
      unknownSources.push('Unknown Source')
      return
    }

    // Get or create array for this file
    const entries = fileGroups.get(source) || []

    // Create entry with available location information
    const entry: { lines?: { from: number; to: number }; page?: number } = {}

    // Add line information if available
    if (location?.lines?.from && location?.lines?.to) {
      entry.lines = {
        from: location.lines.from,
        to: location.lines.to,
      }
    }

    // Add page information if available
    if (location?.pageNumber !== undefined) {
      entry.page = location.pageNumber
    }

    // Only add entry if it has some location information
    if (Object.keys(entry).length > 0) {
      entries.push(entry)
      fileGroups.set(source, entries)
    }
  })

  // Function to merge overlapping line ranges for the same page
  const mergeRanges = (
    entries: Array<{ lines?: { from: number; to: number }; page?: number }>,
  ): Array<{ lines?: { from: number; to: number }; page?: number }> => {
    if (entries.length <= 1) return entries

    // Group entries by page number
    const pageGroups = new Map<
      number | undefined,
      Array<{ lines?: { from: number; to: number }; page?: number }>
    >()

    entries.forEach((entry) => {
      const pageKey = entry.page
      const pageEntries = pageGroups.get(pageKey) || []
      pageEntries.push(entry)
      pageGroups.set(pageKey, pageEntries)
    })

    const result: Array<{ lines?: { from: number; to: number }; page?: number }> = []

    // Process each page group
    pageGroups.forEach((pageEntries, pageNumber) => {
      // For entries with line information, merge overlapping ranges
      const entriesWithLines = pageEntries.filter((e) => e.lines)

      if (entriesWithLines.length > 0) {
        // Sort by starting line
        const sortedEntries = [...entriesWithLines].sort(
          (a, b) => (a.lines?.from || 0) - (b.lines?.from || 0),
        )

        let current = sortedEntries[0]

        // Merge overlapping line ranges
        for (let i = 1; i < sortedEntries.length; i++) {
          const next = sortedEntries[i]

          // Check if ranges overlap or are adjacent
          if ((current.lines?.to || 0) >= (next.lines?.from || 0) - 1) {
            // Merge ranges
            current = {
              lines: {
                from: current.lines?.from || 0,
                to: Math.max(current.lines?.to || 0, next.lines?.to || 0),
              },
              page: pageNumber,
            }
          } else {
            // No overlap, add current to result and move to next
            result.push(current)
            current = next
          }
        }

        // Add the last range
        result.push(current)
      }

      // For entries with only page information (no lines), add a single entry per page
      if (pageEntries.some((e) => !e.lines)) {
        // If we haven't already added an entry for this page from the line merging
        if (!result.some((r) => r.page === pageNumber && !r.lines)) {
          result.push({ page: pageNumber })
        }
      }
    })

    return result
  }

  // Format results
  const formattedResults: string[] = []

  // Process each file group
  fileGroups.forEach((entries, source) => {
    const filename = source.split(/[\/\\]/).pop() || source
    const mergedEntries = mergeRanges(entries)

    // Format each merged entry
    mergedEntries.forEach((entry) => {
      let locationInfo = ''

      // Format based on available information
      if (entry.page !== undefined && entry.lines) {
        // Both page and line information
        locationInfo = `Page ${entry.page}, Lines ${entry.lines.from}-${entry.lines.to}`
      } else if (entry.page !== undefined) {
        // Only page information
        locationInfo = `Page ${entry.page}`
      } else if (entry.lines) {
        // Only line information
        locationInfo = `Lines ${entry.lines.from}-${entry.lines.to}`
      }

      formattedResults.push(`${filename} (${locationInfo})`)
    })
  })

  // Add unknown sources
  formattedResults.push(...unknownSources)

  return formattedResults.join('\n')
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

    currentlyGeneratingKey.value = conversations.activeKey

    const chatContext = JSON.parse(JSON.stringify(conversations.activeConversation))
    chatContext.push({ question: newPrompt, answer: '' })
    generate(chatContext)
    question.value = ''
  } catch {}
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

function copyText(text: string) {
  util.copyText(text)
  toast.success(i18nState.COM_COPY_SUCCESS_TIP)
}

async function addLLMModel() {
  return new Promise<void>(async (resolve, reject) => {
    emits('showModelRequest', resolve, reject)
  })
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
    createdAt: Date.now(),
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

defineExpose({
  checkModel: checkModelAvailability,
})
</script>
