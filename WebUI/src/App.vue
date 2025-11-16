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
  <div
    v-if="theme.active === 'light'"
    class="absolute -z-50 w-screen h-screen bg-cover bg-center bg-light"
  ></div>
  <header
    class="main-title text-2xl font-bold flex justify-between items-center px-4 border-b border-border/20 text-foreground bg-background/20"
    :class="{ 'bg-muted/50': theme.active === 'light' }"
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
        v-if="debugToolsEnabled"
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
        <ServerStackIcon class="size-6 text-foreground"></ServerStackIcon>
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
      class="dialog-container z-10 text-foreground w-[60vw] align-top bg-background/50 p-4 rounded-lg border border-border"
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
              class="bg-muted hover:bg-muted/80 text-foreground font-semibold py-1 px-2 border border-border rounded"
            >
              <i class="fas fa-chevron-down" />
              {{ languages.ERROR_PYTHON_BACKEND_INIT_DETAILS }}
            </button>
          </CollapsibleTrigger>
          <button
            @click="openDevTools"
            variant="default"
            size="sm"
            class="bg-muted hover:bg-muted/80 text-foreground font-semibold py-1 px-2 border border-border rounded"
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
    class="flex-1 flex relative min-h-0"
    :class="{
    'bg-black/50': theme.active === 'lnl',
    'bg-black/80': theme.active === 'bmg',
    'border-t border-border': theme.active === 'dark',
  }"
  >
    <SideModalHistory
      :isVisible="uiStore.showHistory"
      :mode="promptStore.getCurrentMode()"
      @close="uiStore.closeHistory()"
      @conversation-selected="chatRef?.scrollToBottom"
    />
    <SideModalAppSettings :isVisible="showAppSettings" @close="showAppSettings = false" />

    <div class="flex-1 flex flex-col relative justify-center min-h-0">
      <div class="fixed top-18 left-4 z-5">
        <button
          v-show="!uiStore.showHistory"
          @click="openHistory"
          class="text-foreground px-3 py-1.5 bg-muted hover:bg-muted/80 rounded-lg text-sm"
        >
          {{ languages.COM_SHOW_HISTORY }}
        </button>
      </div>
      <div
        class="fixed left-4 z-5 flex items-center gap-3"
        :class="{
          'bottom-4': !footerExpanded,
          'bottom-27': footerExpanded
        }"
      >
        <button
          @click="openAppSettings"
          class="svg-icon i-setup w-6 h-6 text-foreground hover:text-foreground/80 transition-colors"
          title="App Settings"
        ></button>
        <button
          @click="openDevTools"
          class="svg-icon i-code w-6 h-6 text-foreground hover:text-foreground/80 transition-colors"
          title="Developer Tools"
        ></button>
      </div>
      <Chat v-if="promptStore.getCurrentMode() === 'chat'" ref="chatRef" />
      <WorkflowResult
        v-if="promptStore.getCurrentMode() === 'imageGen'"
        ref="imageGenRef"
        mode='imageGen'
      />
      <WorkflowResult
        v-if="promptStore.getCurrentMode() === 'imageEdit'"
        ref="imageEditRef"
        mode='imageEdit'
      />
      <WorkflowResult
        v-if="promptStore.getCurrentMode() === 'video'"
        ref="videoRef"
        mode='video'
      />
      <PromptArea @auto-hide-footer="handleAutoHideFooter" @open-settings="openSpecificSettings" />
      <div
        v-if="!footerExpanded"
        class="fixed bottom-4 right-4 z-5 flex items-center gap-3">
        <button
          @click="footerExpanded = !footerExpanded"
          class="text-foreground/30 hover:text-foreground/80 text-xs uppercase tracking-wider transition-colors"
        >
          SHOW FOOTER
        </button>
      </div>
    </div>

    <SideModalSpecificSettings
      :isVisible="showSpecificSettings"
      :mode="promptStore.getCurrentMode()"
      @close="showSpecificSettings = false"
    />
    <download-dialog v-show="dialogStore.downloadDialogVisible"></download-dialog>
    <warning-dialog v-show="dialogStore.warningDialogVisible"></warning-dialog>
  </main>

  <!-- todo: Old UI only, we should eventually be able to remove this main block -->
  <main
    v-else-if="!useNewUI && globalSetup.loadingState === 'running'"
    class="flex-auto flex flex-col relative"
  >
    <div class="main-tabs flex-none pt-2 px-3 flex items-end justify-start gap-1 text-muted-foreground">
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
        <enhance v-show="activeTabIdx === 'enhance'" ref="enhanceCompt"></enhance>
        <learn-more v-show="activeTabIdx === 'learn-more'"></learn-more>
      </div>
      <app-settings v-if="showSetting" @close="hideAppSettings"></app-settings>
    </div>
    <download-dialog v-show="dialogStore.downloadDialogVisible"></download-dialog>
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
      'border-t border-border': theme.active === 'dark',
    }"
  >
    <div v-if="useNewUI && footerExpanded"
         class="w-full relative flex items-center justify-center pb-1">
      <button
        @click="footerExpanded = !footerExpanded"
        class="text-foreground/30 hover:text-foreground/80 text-xs uppercase tracking-wider transition-colors"
      >
        HIDE FOOTER
      </button>
    </div>
    <div v-show="footerExpanded" class="w-full flex justify-between items-center pb-2">
      <div>
        <p>
          Al Playground from Intel Corporation
          <a href="https://github.com/intel/ai-playground" target="_blank" class="text-primary"
          >https://github.com/intel/ai-playground</a
          >
        </p>
        <p>
          AI Playground version: v{{ productVersion }}
          <a
            href="https://github.com/intel/ai-playground/blob/main/AI%20Playground%20Users%20Guide.pdf"
            target="_blank"
            class="text-primary"
          >
            User Guide</a
          >

          <a
            href="https://github.com/intel/ai-playground/blob/main/notices-disclaimers.md"
            target="_blank"
            class="text-primary"
          >
            | Important Notices and Disclaimers</a
          >

          <a
            href="https://github.com/intel/ai-playground/blob/main/LICENSE"
            target="_blank"
            class="text-primary"
          >
            | Licenses</a
          >
        </p>
      </div>
      <div v-if="theme.active === 'lnl'" class="flex gap-2 items-center">
        <p class="text-muted-foreground text-lg mr-2">Powered by</p>
        <img class="size-20" src="@/assets/image/core_ultra_badge.png" />
        <img class="size-20" src="@/assets/image/arc_graphics_badge.png" />
      </div>
      <div v-if="theme.active === 'bmg'" class="flex gap-2 items-center">
        <p class="text-muted-foreground text-lg mr-2">Powered by</p>
        <img class="size-20" src="@/assets/image/arc_graphics_badge.png" />
      </div>
      <div v-if="theme.active === 'light'" class="flex gap-2 items-center">
        <p class="text-muted-foreground text-lg mr-2">Powered by</p>
        <img class="size-12" src="@/assets/image/arc_graphics_badge.png" />
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
import WorkflowResult from '@/views/WorkflowResult.vue'
import Chat from '@/views/Chat.vue'
import { ref } from 'vue'
import SideModalHistory from '@/components/SideModalHistory.vue'
import SideModalAppSettings from '@/components/SideModalAppSettings.vue'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { usePromptStore } from "@/assets/js/store/promptArea.ts";
import SideModalSpecificSettings from "@/components/SideModalSpecificSettings.vue";
import { useUIStore } from '@/assets/js/store/ui.ts'

const backendServices = useBackendServices()
const theme = useTheme()
const globalSetup = useGlobalSetup()
const demoMode = useDemoMode()
const dialogStore = useDialogStore()
const promptStore = usePromptStore()
const uiStore = useUIStore()

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
const activeTabIdx = ref<AipgPage>('create')
const showSetting = ref(false)
const footerExpanded = ref(true)
const showAppSettings = ref(false)
const showModelRequestDialog = ref(false)
const fullscreen = ref(false)
const useNewUI = ref(true)
const showSpecificSettings = ref(false)

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
  window.electronAPI.onDebugLog(({level, source, message}) => {
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
  // Apply theme class to document root for CSS variables
  watch(() => theme.active, (newTheme) => {
    const root = document.documentElement
    // Remove all theme classes
    root.classList.remove('dark', 'lnl', 'bmg', 'light')
    // Add current theme class (light theme is default via :root, so no class needed)
    if (newTheme !== 'light') {
      root.classList.add(newTheme)
    }
  }, { immediate: true })

  watch([() => globalSetup.loadingState, activeTabIdx] as const, ([loadingState, activeTabIdx]) => {
    if (loadingState === 'running' && !useNewUI.value) {
      setTimeout(() => demoMode.triggerHelp(activeTabIdx))
    }
  })
})

async function setInitalLoadingState() {
  console.log('setting loading state')
  // Wait for service info (non-blocking check)
  if (!backendServices.serviceInfoUpdateReceived) {
    globalSetup.loadingState = 'verifyBackend'
    setTimeout(setInitalLoadingState, 1000)
    return
  }

  // Check if installation dialog is needed
  // Wait for setup checks to complete before deciding
  const needsInstallation = await backendServices.shouldShowInstallationDialog()
  if (needsInstallation) {
    globalSetup.loadingState = 'manageInstallations'
    // Note: Backends are now started automatically by the service registry
    // This call is kept as a fallback for manual restarts
    backendServices.startAllSetUpServicesInBackground()
    return
  }

  // Show UI immediately
  // Note: Backends are now started automatically by the service registry in the main process
  // This ensures they start regardless of frontend state or UI mode
  globalSetup.loadingState = 'running'
  await globalSetup.initSetup()
  
  // Optional: Frontend can still trigger startup as a fallback or for manual restarts
  // but it's no longer required since services start automatically
  backendServices.startAllSetUpServicesInBackground()
}

async function concludeLoadingStateAfterManagedInstallationDialog() {
  // Always try to initialize, even if not all required are set up
  // This allows the UI to be functional with whatever backends are available
  await globalSetup.initSetup()
  globalSetup.loadingState = 'running'
  // Note: Backends are now started automatically by the service registry
  // This call is kept as a fallback for manual restarts after installation
  backendServices.startAllSetUpServicesInBackground()
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

// todo: Why is this not used
function _showModelRequest() {
  showModelRequestDialog.value = true
  nextTick(() => {
    addLLMCompt.value!.onShow()
  })
}

function handleAutoHideFooter() {
  footerExpanded.value = false
}

function openHistory() {
  uiStore.openHistory()
}

function openSpecificSettings() {
  showSpecificSettings.value = true
}

function openAppSettings() {
  showAppSettings.value = true
}
</script>
