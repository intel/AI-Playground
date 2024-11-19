<template>
  <div v-if="theme.active === 'lnl'" class="lnl-grid lnl-top-grid" :class="{ [`pos-${activeTabIdx}`]: true }"></div>
  <div v-if="theme.active === 'lnl'" class="lnl-grid lnl-bottom-grid" :class="{ [`pos-${activeTabIdx}`]: true }"></div>
  <div v-if="theme.active === 'lnl'" class="lnl-gradient"></div>
  <div v-if="theme.active === 'bmg'" class="absolute -z-50 w-screen h-screen bg-cover bg-center bg-bmg"></div>
  <header
    class="main-title text-2xl font-bold flex justify-between items-csssenter px-4 border-b border-white/20 text-white bg-black bg-opacity-20" >
    <div class="flex items-center">
      <h1 class="select-none flex gap-3 items-baseline">
        <span style="color:#00c4fa">AI</span>
        <span>PLAYGROUND</span>
        <span v-if="platformTitle" class="text-sm font-normal">{{ platformTitle }}</span>
      </h1>
    </div>
    <div class="flex justify-between items-center gap-5">
      <button :title="languages.COM_SETTINGS" class="svg-icon i-setup w-6 h-6" @click="showAppSettings"
        ref="showSettingBtn"></button>
      <button :title="languages.COM_MINI" @click="miniWindow" class="svg-icon i-mini w-6 h-6"></button>
      <button :title="fullscreen ? languages.COM_FULLSCREEN_EXIT : languages.COM_FULLSCREEN" @click="toggleFullScreen"
        class="svg-icon w-6 h-6" :class="fullscreen ? 'i-fullscreen-exit' : 'i-fullscreen'"></button>
      <button :title="languages.COM_CLOSE" @click="closeWindow" class="svg-icon i-close w-6 h-6"></button>
    </div>
  </header>
  <main v-if="globalSetup.loadingState === 'loading'" class="flex-auto flex items-center justify-center">
    <loading-bar :text="'AI Playground Loading'" class="w-3/5" style="word-spacing: 8px;"></loading-bar>
  </main>
  <main v-else-if="globalSetup.loadingState === 'failed'" class="flex-auto flex items-start mt-[10vh] justify-center">
    <div class="dialog-container z-10 text-white w-[60vw] align-top bg-black bg-opacity-50 p-4 rounded-lg border border-gray-400">
        <Collapsible v-model:open="isOpen" class=" space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="flex flex-col gap-4">
              <h2 class="text-xl font-semibold">{{ languages.ERROR_PYTHON_BACKEND_INIT}}</h2>
              <p>{{ languages.ERROR_PYTHON_BACKEND_INIT_DETAILS_TEXT }}</p>
            </div>
            <CollapsibleTrigger>
              <button variant="default" size="sm" class="bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold py-1 px-2 border border-gray-400 rounded">
                <i class="fas fa-chevron-down" /> 
                {{ languages.ERROR_PYTHON_BACKEND_INIT_DETAILS }}
              </button>
            </CollapsibleTrigger>
              <button @click="openDevTools" variant="default" size="sm" class="bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold py-1 px-2 border border-gray-400 rounded">
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
  <main v-else class="flex-auto flex flex-col relative">
    <div class="main-tabs flex-none pt-2 px-3 flex items-end justify-start gap-1 text-gray-400">
      <button class="tab" :class="{ 'active': activeTabIdx == 0 }" @click="switchTab(0)">{{ languages.TAB_CREATE
        }}</button>
      <button class="tab" :class="{ 'active': activeTabIdx == 1 }" @click="switchTab(1)">{{ languages.TAB_ENHANCE
        }}</button>
      <button class="tab" :class="{ 'active': activeTabIdx == 2 }" @click="switchTab(2)">{{ languages.TAB_ANSWER
        }}</button>
      <button class="tab" :class="{ 'active': activeTabIdx == 3 }" @click="switchTab(3)">{{ languages.TAB_LEARN_MORE
        }}</button>
      <span class="main-tab-glider tab absolute" :class="{ [`pos-${activeTabIdx}`]: true }"></span>
    </div>
    <div class="main-content flex-auto rounded-t-lg relative">
      <create v-show="activeTabIdx == 0" @postImageToEnhance="postImageToEnhance"
        @show-download-model-confirm="showDownloadModelConfirm"></create>
      <enhance v-show="activeTabIdx == 1" ref="enhanceCompt" @show-download-model-confirm="showDownloadModelConfirm">
      </enhance>
      <answer v-show="activeTabIdx == 2" ref = "answer" @show-download-model-confirm="showDownloadModelConfirm" @show-model-request="showModelRequest"></answer>
      <learn-more v-show="activeTabIdx == 3"></learn-more>
      <app-settings v-if="showSetting" @close="hideAppSettings" @show-download-model-confirm="showDownloadModelConfirm"></app-settings>
    </div>
    <download-dialog v-show="showDowloadDlg" ref="downloadDigCompt" @close="showDowloadDlg = false"></download-dialog>
    <add-l-l-m-dialog v-show="showModelRequestDialog" ref="addLLMCompt" @close="showModelRequestDialog = false" @call-check-model="callCheckModel" @show-warning="showWarning"></add-l-l-m-dialog>
    <warning-dialog v-show="showWarningDialog" ref="warningCompt" @close="showWarningDialog = false"></warning-dialog>
  </main>
  <footer class="flex-none px-4 flex justify-between items-center select-none" :class="{'bg-black bg-opacity-50': theme.active === 'lnl', 'bg-black bg-opacity-80': theme.active === 'bmg', 'border-t border-color-spilter': theme.active === 'dark'}">
    <div>
      <p>Al Playground from Intel Corporation <a href="https://github.com/intel/ai-playground" target="_blank"
          class="text-blue-500">https://github.com/intel/ai-playground</a></p>
      <p>AI Playground version: v{{ productVersion }}
        <a href="https://github.com/intel/ai-playground/blob/main/AI%20Playground%20Users%20Guide.pdf" target="_blank"
        class="text-blue-500">  User Guide</a>

        <a href="https://github.com/intel/ai-playground/blob/main/notices-disclaimers.md" target="_blank"
        class="text-blue-500">  |  Important Notices and Disclaimers</a>

        <a href="https://github.com/intel/ai-playground/blob/main/LICENSE" target="_blank"
        class="text-blue-500">  |  Licenses</a>
      
      </p>
    </div>
    <div v-if="theme.active==='lnl'" class="flex gap-2 items-center">
      <p class="text-gray-300 text-lg mr-2">Powered by</p>
      <img class="size-20" src="@/assets/image/core_ultra_badge.png" />
      <img class="size-20" src="@/assets/image/arc_graphics_badge.png" />
    </div>
    <div v-if="theme.active==='bmg'" class="flex gap-2 items-center">
      <p class="text-gray-300 text-lg mr-2">Powered by</p>
      <img class="size-20" src="@/assets/image/arc_graphics_badge.png" />
    </div>
    <img v-else-if="theme.active==='dark'" src="@/assets/svg/intel.svg" />
  </footer>

</template>

<script setup lang="ts">
import LoadingBar from "./components/LoadingBar.vue";
import { useI18N } from "./assets/js/store/i18n.ts"
import Create from "./views/Create.vue";
import Enhance from "./views/Enhance.vue";
import Answer from "./views/Answer.vue";
import LearnMore from "./views/LearnMore.vue";
import AppSettings from "./views/AppSettings.vue";
import "./assets/css/index.css";
import { useGlobalSetup } from "./assets/js/store/globalSetup";
import DownloadDialog from '@/components/DownloadDialog.vue';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTheme } from "./assets/js/store/theme.ts";
import AddLLMDialog from "@/components/AddLLMDialog.vue";
import WarningDialog from "@/components/WarningDialog.vue";


const isOpen = ref(false);

const theme = useTheme();

const activeTabIdx = ref(0);

const showSetting = ref(false);

const enhanceCompt = ref<InstanceType<typeof Enhance>>();

const answer = ref<InstanceType<typeof Answer>>();

const showSettingBtn = ref<HTMLButtonElement>();

const showDowloadDlg = ref(false);

const showModelRequestDialog = ref(false);

const showWarningDialog = ref(false);

const downloadDigCompt = ref<InstanceType<typeof DownloadDialog>>();

const addLLMCompt = ref<InstanceType<typeof AddLLMDialog>>();

const warningCompt = ref<InstanceType<typeof WarningDialog>>();

const fullscreen = ref(false);

const platformTitle = window.envVars.platformTitle;

const productVersion = window.envVars.productVersion;

const globalSetup = useGlobalSetup();

onBeforeMount(async () => {
  window.electronAPI.onDebugLog(({ level, source, message}) => {
    if (level == "error") {
      console.error(`[${source}] ${message}`);
    }
    if (level == "info") {
      console.log(`[${source}] ${message}`);
    }
  })
  await globalSetup.initSetup();

  document.body.addEventListener("mousedown", autoHideAppSettings);
  document.body.addEventListener("keydown", (e) => {
    if (e.key == "F11") {
      toggleFullScreen();
      e.preventDefault();
    }
  })
})

function showAppSettings() {
  if (showSetting.value === false) {
    showSetting.value = true;
  }
  else {
    showSetting.value = false;
  }
}

function hideAppSettings() {
  showSetting.value = false;
}

function autoHideAppSettings(e: MouseEvent) {
  if (showSetting.value && e.target != showSettingBtn.value && !e.composedPath().find((item)=>{ return item instanceof HTMLElement && item.classList.contains("v-drop-select-list")})) {
    const appSettingsPanel = document.getElementById("app-settings-panel");

    if (appSettingsPanel != null) {
      if (e.target instanceof HTMLElement && e.target.closest("#app-settings-panel") != null) {
        return;
      }
      const rect = appSettingsPanel.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        hideAppSettings();
      }
    }
  }
}

function switchTab(index: number) {
  activeTabIdx.value = index;
}

function miniWindow() {
  window.electronAPI.miniWindow();
}

function toggleFullScreen() {
  fullscreen.value = !fullscreen.value;
  window.electronAPI.setFullScreen(fullscreen.value);
}

function closeWindow() {
  window.electronAPI.exitApp();
}

function openDevTools() {
  window.electronAPI.openDevTools();
}

function postImageToEnhance(imageUrl: string) {
  enhanceCompt.value?.receiveImage(imageUrl);
  activeTabIdx.value = 1;
}

function showDownloadModelConfirm(downList: DownloadModelParam[], success?: () => void, fail?: () => void) {
  showDowloadDlg.value = true;
  nextTick(() => {
    downloadDigCompt.value!.showConfirm(downList, success, fail);
  });
}

function showModelRequest() {
  showModelRequestDialog.value = true;
}

function callCheckModel(){
  answer.value!.checkModel();
}

function showWarning(message : string, func : () => void) {
  warningCompt.value!.warningMessage = message;
  showWarningDialog.value = true;
  warningCompt.value!.confirmFunction = func;
}

</script>
