<template>
  <div id="new-app-view" class="text-white flex flex-col h-full">

    <Chat v-show="currentMode === 'chat'" :ref="modeRefs.chat"/>

    <div class="flex flex-col items-center gap-7 text-base px-4"
         :class="conversations.activeConversation && conversations.activeConversation.length > 0 || processing ? 'py-4' : 'flex-1 justify-center'">
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
            v-for="(label, mode) in modeToLabel"
            :key="mode"
            @click="currentMode = mode as ModeType"
            :class="currentMode === mode ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600'"
            class="px-3 py-1.5 rounded-lg text-sm"
          >
            {{ label }}
          </button>
        </div>
        <div class="absolute bottom-3 right-3 flex gap-2">
          <button
            class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm"
            @click="showSettings = true"
          >
            {{ modeToLabel[currentMode] }} Settings
          </button>
          <button
            @click="handleSubmitPromptClick"
            class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm">
            →
          </button>
        </div>
      </div>
    </div>
    <SettingsNewModal
      :isVisible="showSettings"
      :label="modeToLabel[currentMode]"
      :mode="currentMode"
      @close="showSettings=false"/>
  </div>
</template>

<script setup lang="ts">
import { getCurrentInstance, ref } from 'vue'
import { useConversations } from "@/assets/js/store/conversations.ts";
import Chat from "@/modes/Chat.vue";
import SettingsNewModal from "@/components/SettingsNewModal.vue";

interface ModeComponent {
  handleSubmitPromptClick: (prompt: string) => void
}

type ModeType = 'chat' | 'imageGen' | 'imageEdit' | 'video'

const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const conversations = useConversations()
const question = ref('')
const processing = ref(false)
const currentMode = ref<ModeType>('chat')
const showSettings = ref(false)

const modeRefs: Record<ModeType, Ref<ModeComponent | null>> = {
  chat: ref(null),
  imageGen: ref(null),
  imageEdit: ref(null),
  video: ref(null),
}

const modeToLabel: Record<ModeType, string> = {
  chat: 'Chat',
  imageGen: 'Image Gen',
  imageEdit: 'Image Edit',
  video: 'Video',
}

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

function handleSubmitPromptClick() {
  const refToUse = modeRefs[currentMode.value]
  refToUse.value?.handleSubmitPromptClick(question.value)
  question.value = ''
}

function fastGenerate(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSubmitPromptClick()
  }
}
</script>

<!-- todo: showDownloadModelConfirm needs to be handled or re-emited-->
<!-- todo: showModelRequest needs to be handled or re-emited-->
