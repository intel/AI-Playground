<template>
  <div v-if="theme.active === 'lnl'" class="lnl-grid lnl-top-grid"></div>
  <div v-if="theme.active === 'lnl'" class="lnl-grid lnl-bottom-grid"></div>
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
    <div class="flex items-center gap-4">
      <h1 class="select-none flex gap-2 items-baseline">
        <span class="text-[#00c4fa]">AI</span>
        <span>PLAYGROUND</span>
        <span v-if="productModeStore.productMode" class="text-muted-foreground/60 font-medium">{{
          productModeStore.productMode === 'essentials' ? 'essentials' : 'studio'
        }}</span>
        <span v-if="platformTitle" class="text-sm font-normal">{{ platformTitle }}</span>
      </h1>
    </div>
    <div class="flex items-center">
      <DemoModeIndicator />
    </div>
    <div class="flex justify-between items-center gap-5">
      <HomeAgentToggle
        v-if="globalSetup.loadingState === 'running' && showHomeAgentToggle"
        class="self-center"
      />
      <button
        v-if="showDebugSettings && !demoMode.enabled"
        :title="languages.COM_SETTINGS"
        @click="
          () => {
            const curState = globalSetup.loadingState
            if (curState === 'running') {
              setupWizardStore.openWizard()
            } else if (curState === 'setupWizard') {
              setupWizardStore.dismiss()
            }
          }
        "
        ref="showSettingBtn"
      >
        <ServerStackIcon class="size-6 text-foreground"></ServerStackIcon>
      </button>
      <button
        v-if="globalSetup.loadingState === 'running'"
        :title="languages.MODEL_MANAGER_TITLE"
        :aria-label="languages.MODEL_MANAGER_OPEN"
        @click="uiStore.openModelManager()"
      >
        <CircleStackIcon class="size-6 text-foreground"></CircleStackIcon>
      </button>
      <button
        v-if="globalSetup.loadingState === 'running'"
        id="contextual-help-toggle"
        type="button"
        class="flex size-7 items-center justify-center rounded-full border border-border text-sm font-bold text-foreground transition-colors hover:bg-muted"
        :class="{ 'bg-primary text-primary-foreground border-primary': contextualHelp.active }"
        title="What's this? Click, then click a control to learn about it."
        aria-label="Toggle help mode"
        :aria-pressed="contextualHelp.active"
        @click="contextualHelp.toggle()"
      >
        ?
      </button>
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
    v-show="globalSetup.loadingState === 'setupWizard'"
    class="flex-auto flex items-start justify-center overflow-y-auto py-8 [scrollbar-gutter:stable]"
  >
    <SetupWizard />
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
    v-if="globalSetup.loadingState === 'running'"
    class="flex-1 flex relative min-h-0"
    :class="{
      'bg-black/50': theme.active === 'lnl',
      'bg-black/80': theme.active === 'bmg',
      'border-t border-border': theme.active === 'dark',
    }"
  >
    <SessionsPanel>
      <template #footer>
        <div id="app-settings-button" class="relative">
          <button
            @click="openAppSettings"
            class="svg-icon i-setup w-6 h-6 text-foreground hover:text-foreground/80 transition-colors"
            title="App Settings"
          ></button>
        </div>
        <DemoModeBlocker>
          <button
            @click="openDevTools"
            class="svg-icon i-code w-6 h-6 text-foreground hover:text-foreground/80 transition-colors"
            title="Developer Tools"
          ></button>
        </DemoModeBlocker>
      </template>
    </SessionsPanel>

    <SideModalAppSettings :isVisible="showAppSettings" @close="showAppSettings = false" />

    <SessionTabView>
      <template #viewport>
        <Chat v-if="showsThreadView" ref="threadView" />
        <SessionTimeline v-else ref="timelineView" />
        <PromptArea @auto-hide-footer="handleAutoHideFooter" />
        <div v-if="!footerExpanded" class="fixed bottom-4 right-4 z-5 flex items-center gap-3">
          <button
            @click="footerExpanded = !footerExpanded"
            class="text-foreground/30 hover:text-foreground/80 text-xs uppercase tracking-wider transition-colors"
          >
            SHOW FOOTER
          </button>
        </div>
      </template>
      <template #inferencing>
        <ModeSettingsTab :mode="promptStore.getCurrentMode()" tab="inferencing" />
      </template>
      <template #attributes>
        <ModeSettingsTab :mode="promptStore.getCurrentMode()" tab="attributes" />
      </template>
      <template #artifacts>
        <SessionArtifacts v-if="sessionTabs.shown === 'artifacts'" />
      </template>
      <template #schedules>
        <SchedulesPanel v-if="sessionTabs.schedules" :allowance="sessionTabs.schedules" />
      </template>
    </SessionTabView>

    <!-- Before the dialog layer on purpose: these share a z-index, so DOM order
         decides, and the download / delete dialogs this view opens must be able
         to appear on top of it. -->
    <ModelManager v-if="uiStore.showModelManager" @close="uiStore.closeModelManager()" />
    <download-dialog v-show="dialogStore.downloadDialogVisible"></download-dialog>
    <preset-requirements-dialog
      v-show="dialogStore.presetRequirementsDialogVisible"
    ></preset-requirements-dialog>
    <installation-progress-dialog
      v-show="dialogStore.installationProgressDialogVisible"
    ></installation-progress-dialog>
    <MaskEditorDialog />

    <!-- Demo Mode Overlay -->
    <DemoModeOverlayDriverJsRef ref="demoModeOverlayDriverJs" />
    <DemoModeNotificationDots />
    <DemoModeAutoresetDialog v-if="demoMode.showResetDialog" />
    <ContextualHelpLayer />
  </main>

  <footer
    class="flex-none px-4 flex flex-col justify-between items-center select-none transition-all duration-300"
    :class="{
      'bg-black/50': theme.active === 'lnl',
      'bg-black/80': theme.active === 'bmg',
      'border-t border-border': theme.active === 'dark',
    }"
  >
    <div v-if="footerExpanded" class="w-full relative flex items-center justify-center pb-1">
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
          AI Playground version:
          <TooltipProvider v-if="buildIdentity.length > 0" :delay-duration="200">
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="underline decoration-dotted underline-offset-2 cursor-help"
                  >v{{ productVersion }}</span
                >
              </TooltipTrigger>
              <TooltipContent side="top" class="text-xs">
                <span
                  v-for="line in buildIdentity"
                  :key="line.label"
                  class="block whitespace-nowrap"
                  >{{ line.label }}: {{ line.value }}</span
                >
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span v-else>v{{ productVersion }}</span>
          <a :href="userGuideUrl" target="_blank" class="text-primary"> User Guide</a>

          <a :href="noticesUrl" target="_blank" class="text-primary">
            | Important Notices and Disclaimers</a
          >

          <a :href="licenseUrl" target="_blank" class="text-primary"> | Licenses</a>
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
      <img v-if="theme.active === 'light'" class="h-8" src="@/assets/svg/intel-dark.svg" />
      <img v-else-if="theme.active === 'dark'" class="h-8" src="@/assets/svg/intel.svg" />
    </div>
  </footer>
  <!-- Outside the running-only main: Home Agent setup lives in the wizard. -->
  <warning-dialog v-show="dialogStore.warningDialogVisible"></warning-dialog>
</template>

<script setup lang="ts">
import LoadingBar from './components/LoadingBar.vue'
import SetupWizard from './components/SetupWizard.vue'
import PromptArea from '@/views/PromptArea.vue'
import './assets/css/index.css'
import { useGlobalSetup } from './assets/js/store/globalSetup'
import { useProductMode } from './assets/js/store/productMode'
import DownloadDialog from '@/components/DownloadDialog.vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTheme } from './assets/js/store/theme.ts'
import WarningDialog from '@/components/WarningDialog.vue'
import PresetRequirementsDialog from '@/components/PresetRequirementsDialog.vue'
import InstallationProgressDialog from '@/components/InstallationProgressDialog.vue'
import MaskEditorDialog from '@/components/MaskEditorDialog.vue'
import DemoModeIndicator from '@/components/DemoModeIndicator.vue'
import { CircleStackIcon, ServerStackIcon } from '@heroicons/vue/24/solid'
import ModelManager from '@/views/ModelManager.vue'
import { useColorMode } from '@vueuse/core'
import { useDemoMode } from './assets/js/store/demoMode.ts'
import { debugSettingsVisible } from './assets/js/store/debugSettings.ts'
import SessionTimeline from '@/views/SessionTimeline.vue'
import Chat from '@/views/Chat.vue'
import { computed, ref, watch } from 'vue'
import SessionsPanel from '@/components/SessionsPanel.vue'
import SessionTabView from '@/components/SessionTabView.vue'
import ModeSettingsTab from '@/components/ModeSettingsTab.vue'
import SessionArtifacts from '@/components/SessionArtifacts.vue'
import SchedulesPanel from '@/components/SchedulesPanel.vue'
import SideModalAppSettings from '@/components/SideModalAppSettings.vue'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { usePromptStore } from '@/assets/js/store/promptArea.ts'
import { useUIStore } from '@/assets/js/store/ui.ts'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import * as toast from '@/assets/js/toast'
import DemoModeOverlayDriverJsRef from './components/DemoModeOverlayDriverJs.vue'
import DemoModeBlocker from '@/components/DemoModeBlocker.vue'
import DemoModeNotificationDots from '@/components/DemoModeNotificationDots.vue'
import DemoModeAutoresetDialog from '@/components/DemoModeAutoresetDialog.vue'
import HomeAgentToggle from '@/components/HomeAgentToggle.vue'
import ContextualHelpLayer from '@/components/ContextualHelpLayer.vue'
import { useContextualHelp } from '@/assets/js/store/contextualHelp'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useI18N } from '@/assets/js/store/i18n'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { usesSessionSettings } from '@/lib/agentSessionSettings'
import { useModePromptHandlers } from '@/lib/useModePromptHandlers'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionTabs } from '@/assets/js/store/sessionTabs'
import { useConversations } from '@/assets/js/store/conversations'

const theme = useTheme()
const globalSetup = useGlobalSetup()
const productModeStore = useProductMode()
const demoMode = useDemoMode()
const contextualHelp = useContextualHelp()
const dialogStore = useDialogStore()
const promptStore = usePromptStore()
const uiStore = useUIStore()
const setupWizardStore = useSetupWizard()
const presetSwitching = usePresetSwitching()
const oemBranding = useOemBranding()
const i18n = useI18N()
const agentMode = useAgentMode()
const sessions = useSessions()
const conversations = useConversations()
const sessionTabs = useSessionTabs()

// Agent Maker sessions can notify over Home Agent; the games presets cannot.
const showHomeAgentToggle = computed(() => {
  const mode = promptStore.getCurrentMode()
  if (mode === 'chat' || mode === 'imageGen') return true
  return mode === 'agent' && usesSessionSettings(agentMode.activeAgentPreset)
})

const demoModeOverlayDriverJs = ref<InstanceType<typeof DemoModeOverlayDriverJsRef>>()
const showSettingBtn = ref<HTMLButtonElement>()
const threadView = ref<InstanceType<typeof Chat> | null>(null)
const timelineView = ref<InstanceType<typeof SessionTimeline> | null>(null)

// A Home Agent thread is no Session's, so it keeps a view of its own.
const showsThreadView = computed(
  () =>
    promptStore.getCurrentMode() === 'chat' &&
    (!sessions.openSessionId ||
      conversations.getThreadKind(conversations.activeKey) === 'homeAgent'),
)

useModePromptHandlers({
  scrollToBottom: () => (timelineView.value ?? threadView.value)?.scrollToBottom(),
})

const isOpen = ref(false)
const footerExpanded = ref(true)
const showAppSettings = ref(false)
const fullscreen = ref(false)

const platformTitle = window.envVars.platformTitle
const productVersion = window.envVars.productVersion
const showDebugSettings = debugSettingsVisible()

// Which build this is, for telling test builds apart. Both parts are absent in a
// build made from a tree without git history, and then the version gets no hover.
const buildIdentity = [
  { label: 'Release tag', value: window.envVars.gitTag },
  { label: 'Commit', value: window.envVars.gitCommit },
].filter((entry) => !!entry.value)

const gitHubRepoUrl = ref('https://github.com/intel/ai-playground/blob/main/')
const userGuideUrl = computed(() => `${gitHubRepoUrl.value}AI%20Playground%20Users%20Guide.pdf`)
const noticesUrl = computed(() => `${gitHubRepoUrl.value}notices-disclaimers.md`)
const licenseUrl = computed(() => `${gitHubRepoUrl.value}LICENSE`)

const mode = useColorMode()
mode.value = 'dark'

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

  // document.body.addEventListener('mousedown', autoHideAppSettings)
  document.body.addEventListener('keydown', (e) => {
    if (e.key == 'F11') {
      toggleFullScreen()
      e.preventDefault()
    }
  })
  await setupWizardStore.initialize()
})

onMounted(async () => {
  // Fetch dynamic GitHub repo URL for footer links
  gitHubRepoUrl.value = await window.electronAPI.getGitHubRepoUrl()

  // Which OEM's machine this is decides co-branded labels (e.g. Acer Game Agent).
  void oemBranding.initialize()

  // Apply theme class to document root for CSS variables
  watch(
    () => theme.active,
    (newTheme) => {
      const root = document.documentElement
      // Remove all theme classes
      root.classList.remove('dark', 'lnl', 'bmg', 'light')
      // Add current theme class (light theme is default via :root, so no class needed)
      if (newTheme !== 'light') {
        root.classList.add(newTheme)
      }
    },
    { immediate: true },
  )

  // Listen for toast messages from main process
  window.electronAPI.onShowToast((data) => {
    if (data.type === 'warning') {
      toast.warning(data.message, { duration: 10000 })
    } else if (data.type === 'error') {
      toast.error(data.message)
    } else if (data.type === 'success') {
      toast.success(data.message)
    } else {
      toast.show(data.message)
    }
  })
})

function miniWindow() {
  window.electronAPI.miniWindow()
}

function toggleFullScreen() {
  fullscreen.value = !fullscreen.value
  window.electronAPI.setFullScreen(fullscreen.value)
}

let closeInFlight = false

async function closeWindow() {
  if (closeInFlight) return
  closeInFlight = true
  try {
    const keepAlive = await window.electronAPI.tasksKeepAlive().catch(() => false)
    if (keepAlive) {
      const keep = await dialogStore.requestConfirmation(
        i18n.state.AGENT_TASKS_CLOSE_CONFIRM ??
          'An agent is scheduled or still running. Keep AI Playground running in the background, or quit and stop it?',
        {
          confirm: i18n.state.AGENT_TASKS_KEEP_RUNNING ?? 'Keep running',
          cancel: i18n.state.AGENT_TASKS_QUIT ?? 'Quit',
        },
      )
      if (keep) {
        window.electronAPI.hideMainWindow()
        return
      }
    }
    window.electronAPI.exitApp()
  } finally {
    closeInFlight = false
  }
}

function openDevTools() {
  window.electronAPI.openDevTools()
}

function handleAutoHideFooter() {
  footerExpanded.value = false
}

function openAppSettings() {
  if (demoMode.triggerFirstTimeHelp('app-settings-button')) return
  showAppSettings.value = true
}

function startTour() {
  demoModeOverlayDriverJs.value?.startTour?.()
}

watch(
  () => globalSetup.loadingState,
  (state) => {
    if (state !== 'running') return
    // The prompt store isn't persisted, so the app boots in chat mode while the
    // active preset comes back from disk — and an agent preset means Agent Mode.
    presetSwitching.syncModeWithActivePreset()
    if (demoMode.enabled) {
      void demoMode.applyExplicitDefaults()
      window.setTimeout(startTour, 2200)
    }
  },
)
</script>
