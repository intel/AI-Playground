<template>
  <div
    v-if="theme.active === 'lnl'"
    class="lnl-grid lnl-top-grid"
    :class="{ [`pos-${activeTabIdx}`]: true }"
  ></div>
  <div
    v-if="theme.active === 'lnl'"
    class="lnl-grid lnl-bottom-grid"
    :class="{ [`pos-${activeTabIdx}`]: true }"
  ></div>
  <div v-if="theme.active === 'lnl'" class="lnl-gradient"></div>
  <div
    v-if="theme.active === 'bmg'"
    class="absolute -z-50 w-screen h-screen bg-cover bg-center bg-bmg"
  ></div>
  <header
    class="main-title text-2xl font-bold flex justify-between items-center px-4 border-b border-white/20 text-white bg-black/20"
  >
    <div class="flex items-center">
      <h1 class="select-none flex gap-3 items-baseline">
        <span style="color: #00c4fa">AI</span>
        <span>PLAYGROUND</span>
        <span v-if="platformTitle" class="text-sm font-normal">{{ platformTitle }}</span>
      </h1>
    </div>
    <div class="flex justify-between items-center gap-5">
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" v-model="useNewUI" class="w-4 h-4 cursor-pointer" />
        <span class="text-sm">New UI</span>
      </label>
      <button
        v-if="debugToolsEnabled && !useNewUI"
        :title="languages.COM_SETTINGS"
        @click="
          () => {
            const curState = globalSetup.loadingState
            if (curState === 'running') {
              globalSetup.loadingState = 'manageInstallations'
            } else if (curState === 'manageInstallations') {
              globalSetup.loadingState = 'running'
            }
          }
        "
        ref="showSettingBtn"
      >
        <ServerStackIcon class="size-6 text-white"></ServerStackIcon>
      </button>
      <button
        v-if="!demoMode.enabled && !useNewUI"
        :title="languages.COM_SETTINGS"
        class="svg-icon i-setup w-6 h-6"
        @click="showSettings"
        ref="showSettingBtn"
      ></button>
      <button
        v-if="!demoMode.enabled"
        :title="languages.COM_MINI"
        @click="miniWindow"
        class="svg-icon i-mini w-6 h-6"
      ></button>
      <button
        v-if="!demoMode.enabled"
        :title="fullscreen ? languages.COM_FULLSCREEN_EXIT : languages.COM_FULLSCREEN"
        @click="toggleFullScreen"
        class="svg-icon w-6 h-6"
        :class="fullscreen ? 'i-fullscreen-exit' : 'i-fullscreen'"
      ></button>
      <button
        :title="languages.COM_CLOSE"
        @click="closeWindow"
        class="svg-icon i-close w-6 h-6"
      ></button>
    </div>
  </header>
  <main
    v-show="globalSetup.loadingState === 'verifyBackend'"
    class="flex-auto flex items-center justify-center"
  >
    <loading-bar
      :text="languages.LOADING_VERIFYING_BACKENDS"
      class="w-3/5"
      style="word-spacing: 8px"
    ></loading-bar>
  </main>
  <main
    v-show="globalSetup.loadingState === 'manageInstallations'"
    class="flex-auto flex items-center justify-center"
  >
    <installation-management
      @close="concludeLoadingStateAfterManagedInstallationDialog"
    ></installation-management>
  </main>
  <main
    v-show="globalSetup.loadingState === 'loading'"
    class="flex-auto flex items-center justify-center"
  >
    <loading-bar
      :text="languages.LOADING_AI_PLAYGROUND_LOADING"
      class="w-3/5"
      style="word-spacing: 8px"
    ></loading-bar>
  </main>
  <main
    v-show="globalSetup.loadingState === 'failed'"
    class="flex-auto flex items-start mt-[10vh] justify-center"
  >
    <div
      class="dialog-container z-10 text-white w-[60vw] align-top bg-black/50 p-4 rounded-lg border border-gray-400"
    >
      <Collapsible v-model:open="isOpen" class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex flex-col gap-4">
            <h2 class="text-xl font-semibold">{{ languages.ERROR_PYTHON_BACKEND_INIT }}</h2>
            <p>{{ languages.ERROR_PYTHON_BACKEND_INIT_DETAILS_TEXT }}</p>
          </div>
          <CollapsibleTrigger>
            <button
              variant="default"
              size="sm"
              class="bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold py-1 px-2 border border-gray-400 rounded"
            >
              <i class="fas fa-chevron-down" />
              {{ languages.ERROR_PYTHON_BACKEND_INIT_DETAILS }}
            </button>
          </CollapsibleTrigger>
          <button
            @click="openDevTools"
            variant="default"
            size="sm"
            class="bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold py-1 px-2 border border-gray-400 rounded"
          >
            <i class="fas fa-chevron-down" />
            {{ languages.ERROR_PYTHON_BACKEND_INIT_OPEN_LOG }}
          </button>
        </div>
        <CollapsibleContent class="max-h-[50vh] overflow-scroll px-4 py-2">
          <pre class="whitespace-pre-wrap">{{ globalSetup.errorMessage }}</pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  </main>

  <main
    v-if="useNewUI && globalSetup.loadingState === 'running'"
    class="flex-1 flex flex-col relative justify-center min-h-0"
    :class="{
      'bg-black/50': theme.active === 'lnl',
      'bg-black/80': theme.active === 'bmg',
      'border-t border-color-spilter': theme.active === 'dark',
    }"
  >
    <div class="absolute top-4 left-4">
      <button
        v-show="!showHistory"
        @click="openHistory"
        class="text-white px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm"
      >
        {{ languages.COM_SHOW_HISTORY }}
      </button>
    </div>
    <SideModalHistory
      :isVisible="showHistory"
      :mode="currentMode"
      @close="showHistory = false"
      @conversation-selected="chatRef?.scrollToBottom"
    />
    <SideModalAppSettings :isVisible="showAppSettings" @close="showAppSettings = false" />
    <Chat v-show="currentMode === 'chat'" ref="chatRef" />
    <ImageGen v-show="currentMode === 'imageGen'" ref="imageGenRef" />
    <ImageEdit v-show="currentMode === 'imageEdit'" ref="imageEditRef" />
    <Video v-show="currentMode === 'video'" ref="videoRef" />
    <PromptArea
      :currentMode="currentMode"
      @select-mode="currentMode = $event"
      @submit-prompt="handleSubmitPrompt"
      @auto-hide-footer="handleAutoHideFooter"
    />
    <app-settings v-if="showSetting" @close="hideAppSettings"></app-settings>
    <download-dialog v-show="dialogStore.downloadDialogVisible"></download-dialog>
    <warning-dialog v-show="dialogStore.warningDialogVisible"></warning-dialog>
  </main>

  <!-- todo: Old UI only, we should eventually be able to remove this main block -->
  <main
    v-else-if="!useNewUI && globalSetup.loadingState === 'running'"
    class="flex-auto flex flex-col relative"
  >
    <div class="main-tabs flex-none pt-2 px-3 flex items-end justify-start gap-1 text-gray-400">
      <button
        class="tab"
        :class="{ active: activeTabIdx === 'create' }"
        @click="() => (activeTabIdx = 'create')"
      >
        {{ languages.TAB_CREATE }}
      </button>
      <button
        class="tab"
        :class="{ active: activeTabIdx === 'enhance' }"
        @click="() => (activeTabIdx = 'enhance')"
      >
        {{ languages.TAB_ENHANCE }}
      </button>
      <button
        class="tab"
        :class="{ active: activeTabIdx === 'answer' }"
        @click="() => (activeTabIdx = 'answer')"
      >
        {{ languages.TAB_ANSWER }}
      </button>
      <button
        class="tab"
        :class="{ active: activeTabIdx === 'learn-more' }"
        @click="() => (activeTabIdx = 'learn-more')"
      >
        {{ languages.TAB_LEARN_MORE }}
      </button>
      <span class="main-tab-glider tab absolute" :class="{ [`pos-${activeTabIdx}`]: true }"></span>
      <button
        v-if="demoMode.enabled"
        class="demo-help-button"
        ref="needHelpBtn"
        @click="
          (event) => {
            event.stopPropagation()
            demoMode.triggerHelp(activeTabIdx, true)
          }
        "
      >
        {{ languages.DEMO_NEED_HELP }}
      </button>
    </div>
    <div class="main-content-container flex-auto rounded-t-lg flex">
      <div class="main-content-area flex-auto">
        <CreateDemo></CreateDemo>
        <AnswerDemo></AnswerDemo>
        <EnhanceDemo></EnhanceDemo>
        <create
          v-show="activeTabIdx === 'create'"
          ref="createCompt"
          @postImageToEnhance="postImageToEnhance"
        ></create>
        <enhance v-show="activeTabIdx === 'enhance'" ref="enhanceCompt"> </enhance>
        <Answer v-show="activeTabIdx === 'answer'" @show-model-request="showModelRequest"></Answer>
        <learn-more v-show="activeTabIdx === 'learn-more'"></learn-more>
      </div>
      <app-settings v-if="showSetting" @close="hideAppSettings"></app-settings>
    </div>
    <download-dialog v-show="showDowloadDlg" @close="showDowloadDlg = false"></download-dialog>
    <add-l-l-m-dialog
      v-show="showModelRequestDialog"
      ref="addLLMCompt"
      @close="showModelRequestDialog = false"
    ></add-l-l-m-dialog>
    <warning-dialog v-show="dialogStore.warningDialogVisible"></warning-dialog>
  </main>
  <footer
    class="flex-none px-4 flex flex-col justify-between items-center select-none transition-all duration-300"
    :class="{
      'bg-black/50': theme.active === 'lnl',
      'bg-black/80': theme.active === 'bmg',
      'border-t border-color-spilter': theme.active === 'dark',
    }"
  >
    <div class="w-full relative flex items-center justify-center pb-1">
      <div class="absolute left-0 flex items-center gap-3 pb-4">
        <button
          @click="openAppSettings"
          class="svg-icon i-setup w-6 h-6 text-white hover:text-white/80 transition-colors"
          title="App Settings"
        ></button>
        <button
          @click="openDevTools"
          class="svg-icon i-code w-6 h-6 text-white hover:text-white/80 transition-colors"
          title="Developer Tools"
        ></button>
      </div>

      <button
        @click="footerExpanded = !footerExpanded"
        class="text-white/30 hover:text-white/80 text-xs uppercase tracking-wider transition-colors"
      >
        {{ footerExpanded ? 'HIDE FOOTER' : 'SHOW FOOTER' }}
      </button>
    </div>
    <div v-show="footerExpanded" class="w-full flex justify-between items-center pb-2">
      <div>
        <p>
          Al Playground from Intel Corporation
          <a href="https://github.com/intel/ai-playground" target="_blank" class="text-blue-500"
            >https://github.com/intel/ai-playground</a
          >
        </p>
        <p>
          AI Playground version: v{{ productVersion }}
          <a
            href="https://github.com/intel/ai-playground/blob/main/AI%20Playground%20Users%20Guide.pdf"
            target="_blank"
            class="text-blue-500"
          >
            User Guide</a
          >

          <a
            href="https://github.com/intel/ai-playground/blob/main/notices-disclaimers.md"
            target="_blank"
            class="text-blue-500"
          >
            | Important Notices and Disclaimers</a
          >

          <a
            href="https://github.com/intel/ai-playground/blob/main/LICENSE"
            target="_blank"
            class="text-blue-500"
          >
            | Licenses</a
          >
        </p>
      </div>
      <div v-if="theme.active === 'lnl'" class="flex gap-2 items-center">
        <p class="text-gray-300 text-lg mr-2">Powered by</p>
        <img class="size-20" src="@/assets/image/core_ultra_badge.png" />
        <img class="size-20" src="@/assets/image/arc_graphics_badge.png" />
      </div>
      <div v-if="theme.active === 'bmg'" class="flex gap-2 items-center">
        <p class="text-gray-300 text-lg mr-2">Powered by</p>
        <img class="size-20" src="@/assets/image/arc_graphics_badge.png" />
      </div>
      <img v-else-if="theme.active === 'dark'" src="@/assets/svg/intel.svg" />
    </div>
  </footer>
</template>

<script setup lang="ts">
import CreateDemo from './components/demo-mode/CreateDemo.vue'
import AnswerDemo from './components/demo-mode/AnswerDemo.vue'
import EnhanceDemo from './components/demo-mode/EnhanceDemo.vue'
import LoadingBar from './components/LoadingBar.vue'
import InstallationManagement from './components/InstallationManagement.vue'
import Create from './views/Create.vue'
import Enhance from './views/Enhance.vue'
import PromptArea from '@/views/PromptArea.vue'
import LearnMore from './views/LearnMore.vue'
import AppSettings from './views/AppSettings.vue'
import './assets/css/index.css'
import { useGlobalSetup } from './assets/js/store/globalSetup'
import DownloadDialog from '@/components/DownloadDialog.vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTheme } from './assets/js/store/theme.ts'
import AddLLMDialog from '@/components/AddLLMDialog.vue'
import WarningDialog from '@/components/WarningDialog.vue'
import { useBackendServices } from './assets/js/store/backendServices.ts'
import { ServerStackIcon } from '@heroicons/vue/24/solid'
import { useColorMode } from '@vueuse/core'
import { useDemoMode } from './assets/js/store/demoMode.ts'
import ImageEdit from '@/views/ImageEdit.vue'
import Video from '@/views/Video.vue'
import ImageGen from '@/views/ImageGen.vue'
import Chat from '@/views/Chat.vue'
import Answer from '@/views/Answer.vue'
import { ref } from 'vue'
import SideModalHistory from '@/components/SideModalHistory.vue'
import SideModalAppSettings from '@/components/SideModalAppSettings.vue'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'

const backendServices = useBackendServices()
const theme = useTheme()
const globalSetup = useGlobalSetup()
const demoMode = useDemoMode()
const dialogStore = useDialogStore()

const enhanceCompt = ref<InstanceType<typeof Enhance>>()
const addLLMCompt = ref<InstanceType<typeof AddLLMDialog>>()
const showSettingBtn = ref<HTMLButtonElement>()
const needHelpBtn = ref<HTMLButtonElement>()
const chatRef = ref<{
  handleSubmitPromptClick: (prompt: string) => void
  scrollToBottom: () => void
}>()
const imageGenRef = ref<{ handleSubmitPromptClick: (prompt: string) => void }>()
const imageEditRef = ref<{ handleSubmitPromptClick: (prompt: string) => void }>()
const videoRef = ref<{ handleSubmitPromptClick: (prompt: string) => void }>()

const isOpen = ref(false)
const currentMode = ref<ModeType>('chat')
const activeTabIdx = ref<AipgPage>('create')
const showSetting = ref(false)
const footerExpanded = ref(true)
const showHistory = ref(false)
const showAppSettings = ref(false)
const showDowloadDlg = ref(false)
const showModelRequestDialog = ref(false)
const fullscreen = ref(false)
const useNewUI = ref(true)

const platformTitle = window.envVars.platformTitle
const productVersion = window.envVars.productVersion
const debugToolsEnabled = window.envVars.debugToolsEnabled

const mode = useColorMode()
mode.value = 'dark'
let initialPage: AipgPage = 'create'

const zoomIn = (event: KeyboardEvent) => {
  if (event.ctrlKey && event.code === 'Equal') window.electronAPI.zoomIn()
}

const wheelZoom = (event: WheelEvent) => {
  if (!event.ctrlKey) return
  if (event.deltaY < 0) {
    window.electronAPI.zoomIn()
  } else {
    window.electronAPI.zoomOut()
  }
}

onBeforeMount(async () => {
  window.removeEventListener('keydown', zoomIn)
  window.addEventListener('keydown', zoomIn, true)
  window.removeEventListener('wheel', wheelZoom)
  window.addEventListener('wheel', wheelZoom, true)
  window.electronAPI.onDebugLog(({ level, source, message }) => {
    if (level == 'error') {
      if (message.startsWith('onednn_verbose')) return
      console.error(`[${source}] ${message}`)
    }
    if (level == 'warn') {
      console.warn(`[${source}] ${message}`)
    }
    if (level == 'info') {
      console.log(`[${source}] ${message}`)
    }
  })

  /** Get command line parameters and load default page on AIPG screen  */
  window.electronAPI.getInitialPage().then((res) => {
    initialPage = res
    activeTabIdx.value = initialPage
  })

  // document.body.addEventListener('mousedown', autoHideAppSettings)
  document.body.addEventListener('keydown', (e) => {
    if (e.key == 'F11') {
      toggleFullScreen()
      e.preventDefault()
    }
  })
  await setInitalLoadingState()
})

onMounted(() => {
  watch([() => globalSetup.loadingState, activeTabIdx] as const, ([loadingState, activeTabIdx]) => {
    if (loadingState === 'running' && !useNewUI.value) {
      setTimeout(() => demoMode.triggerHelp(activeTabIdx))
    }
  })
})

async function setInitalLoadingState() {
  console.log('setting loading state')
  if (!backendServices.serviceInfoUpdateReceived) {
    globalSetup.loadingState = 'verifyBackend'
    setTimeout(setInitalLoadingState, 1000)
    return
  }
  if (backendServices.allRequiredSetUp) {
    globalSetup.loadingState = 'loading'
    const result = await backendServices.startAllSetUpServices()
    if (result.allServicesStarted) {
      await globalSetup.initSetup()
      globalSetup.loadingState = 'running'
      return
    }
  }
  globalSetup.loadingState = 'manageInstallations'
}

async function concludeLoadingStateAfterManagedInstallationDialog() {
  if (backendServices.allRequiredSetUp) {
    await globalSetup.initSetup()
    globalSetup.loadingState = 'running'
  }
}

/** Get tooltips of AIPG demo mode on click of Help button */
const createCompt = ref()

function showSettings() {
  showSetting.value = showSetting.value === false
}

function hideAppSettings() {
  showSetting.value = false
}

function miniWindow() {
  window.electronAPI.miniWindow()
}

function toggleFullScreen() {
  fullscreen.value = !fullscreen.value
  window.electronAPI.setFullScreen(fullscreen.value)
}

function closeWindow() {
  window.electronAPI.exitApp()
}

function openDevTools() {
  window.electronAPI.openDevTools()
}

function postImageToEnhance(imageUrl: string) {
  enhanceCompt.value?.receiveImage(imageUrl)
  activeTabIdx.value = 'enhance'
}

function showModelRequest() {
  showModelRequestDialog.value = true
  nextTick(() => {
    addLLMCompt.value!.onShow()
  })
}

function handleSubmitPrompt(prompt: string, mode: ModeType) {
  const refMap = {
    chat: chatRef,
    imageGen: imageGenRef,
    imageEdit: imageEditRef,
    video: videoRef,
  }

  const componentRef = refMap[mode]
  componentRef.value?.handleSubmitPromptClick(prompt)
}

function handleAutoHideFooter() {
  footerExpanded.value = false
}

function openHistory() {
  showHistory.value = true
}

function openAppSettings() {
  showAppSettings.value = true
}
</script>
