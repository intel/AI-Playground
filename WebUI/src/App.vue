<template>
  <header
    class="main-title text-2xl font-bold flex justify-between items-csssenter px-4 border-b border-color-spilter text-white">
    <div class="flex gap-5 items-center">
      <h1 class="select-none flex gap-2"><span style="color:#00c4fa">AI</span><span>PLAYGROUND</span></h1>
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
  <main v-if="loading" class="flex-auto flex items-center justify-center">
    <loading-bar :text="'AI Playground Loading'" class="w-3/5" style="word-spacing: 8px;"></loading-bar>
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
    </div>
    <div class="main-content flex-auto rounded-t-lg border-t relative">
      <create v-show="activeTabIdx == 0" @postImageToEnhance="postImageToEnhance"
        @show-download-model-confirm="showDownloadModelConfirm"></create>
      <enhance v-show="activeTabIdx == 1" ref="enhanceCompt" @show-download-model-confirm="showDownloadModelConfirm">
      </enhance>
      <answer v-show="activeTabIdx == 2" @show-download-model-confirm="showDownloadModelConfirm"></answer>
      <learn-more v-show="activeTabIdx == 3"></learn-more>
      <app-settings v-if="showSetting" @close="hideAppSettings" @show-download-model-confirm="showDownloadModelConfirm"></app-settings>
    </div>
    <download-dialog v-show="showDowloadDlg" ref="downloadDigCompt" @close="showDowloadDlg = false"></download-dialog>
  </main>
  <footer class="flex-none mx-4 border-t border-color-spilter flex justify-between items-center select-none">
    <div>
      <p>Al Playground from Intel Corporation <a href="https://github.com/intel/ai-playground" target="_blank"
          class="text-blue-500">https://github.com/intel/ai-playground</a></p>
      <p>AI Playground version: v{{ "1.01b" }} 
        <a href="https://github.com/intel/ai-playground/blob/main/AI%20Playground%20Users%20Guide.pdf" target="_blank"
        class="text-blue-500">  User Guide</a>

        <a href="https://github.com/intel/ai-playground/blob/main/notices-disclaimers.md" target="_blank"
        class="text-blue-500">  |  Important Notices and Disclaimers</a>

        <a href="https://github.com/intel/ai-playground/blob/main/LICENSE" target="_blank"
        class="text-blue-500">  |  Licenses</a>
      
      </p>
    </div>
    <img src="@/assets/svg/intel.svg" />
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

const loading = ref(true);

const i18n = useI18N();

const activeTabIdx = ref(0);

const showSetting = ref(false);

const enhanceCompt = ref<InstanceType<typeof Enhance>>();

const showSettingBtn = ref<HTMLButtonElement>();

const showDowloadDlg = ref(false);

const downloadDigCompt = ref<InstanceType<typeof DownloadDialog>>();

const fullscreen = ref(false);

onBeforeMount(async () => {
  
  await useGlobalSetup().initSetup();
  document.body.addEventListener("mousedown", autoHideAppSettings);
  document.body.addEventListener("keydown", (e) => {
    if (e.key == "F11") {
      toggleFullScreen();
      e.preventDefault();
    }
  })
  loading.value = false;
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
</script>
