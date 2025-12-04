<template>
  <div class="dialog-container z-10">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/55 flex justify-center items-center"
    >
      <div
        class="py-10 px-20 w-600px flex flex-col items-center justify-center bg-card rounded-3xl gap-6 text-foreground"
        :class="{ 'animate-scale-in': animate }"
      >
        <h2 class="text-xl font-semibold text-center">
          {{ i18nState.INSTALLATION_PROGRESS_TITLE || 'Installing Preset Requirements' }}
        </h2>

        <div v-if="progressData" class="w-full flex flex-col gap-4">
          <!-- Overall Progress -->
          <div class="flex flex-col gap-2">
            <div class="flex justify-between items-center text-sm">
              <span class="text-muted-foreground">
                {{ i18nState.INSTALLATION_PROGRESS_OVERALL || 'Overall Progress' }}
              </span>
              <span class="font-semibold">{{ Math.round(progressData.overallProgress) }}%</span>
            </div>
            <progress-bar :percent="progressData.overallProgress" class="w-full"></progress-bar>
          </div>

          <!-- Current Phase Status -->
          <div class="flex flex-col gap-2">
            <div class="text-sm text-muted-foreground">
              {{ getPhaseLabel(progressData.currentPhase) }}
            </div>
            <div v-if="progressData.currentItem" class="text-base font-medium">
              {{ progressData.currentItem }}
            </div>
            <div v-if="progressData.totalItems > 0" class="text-sm text-muted-foreground">
              {{ progressData.completedItems }} / {{ progressData.totalItems }}
            </div>
          </div>

          <!-- Status Message -->
          <div class="text-center text-sm text-muted-foreground min-h-[2rem]">
            {{ progressData.statusMessage }}
          </div>

          <!-- Error Display -->
          <div
            v-if="progressData.error"
            class="p-4 bg-red-500/10 border border-red-500/50 rounded-lg"
          >
            <p class="text-red-500 font-semibold mb-2">
              {{ i18nState.INSTALLATION_PROGRESS_ERROR || 'Installation Error' }}
            </p>
            <p class="text-sm text-red-400">{{ progressData.error }}</p>
          </div>

          <!-- Model Download Phase Indicator -->
          <div
            v-if="
              progressData.currentPhase === 'downloading_models' && progressData.showModelDownload
            "
            class="p-4 bg-primary/10 border border-primary/50 rounded-lg text-center"
          >
            <p class="text-sm">
              {{ i18nState.INSTALLATION_PROGRESS_DOWNLOADING_MODELS || 'Downloading models...' }}
            </p>
            <p class="text-xs text-muted-foreground mt-2">
              {{
                i18nState.INSTALLATION_PROGRESS_DOWNLOAD_DIALOG ||
                'The download dialog will appear next.'
              }}
            </p>
          </div>
        </div>

        <!-- Action Buttons -->
        <div v-if="progressData?.error" class="flex justify-center items-center gap-9">
          <button @click="closeDialog" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_CLOSE || 'Close' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18N } from '@/assets/js/store/i18n.ts'
import { useDialogStore, type InstallationPhase } from '@/assets/js/store/dialogs.ts'
import { storeToRefs } from 'pinia'
import ProgressBar from './ProgressBar.vue'

const i18nState = useI18N().state
const dialogStore = useDialogStore()
const animate = ref(false)

const { installationProgressData, installationProgressDialogVisible } = storeToRefs(dialogStore)

const progressData = computed(() => installationProgressData.value)

watch(installationProgressDialogVisible, (newValue) => {
  if (newValue) {
    animate.value = false
    nextTick(() => {
      animate.value = true
    })
  } else {
    animate.value = false
  }
})

function getPhaseLabel(phase: InstallationPhase): string {
  switch (phase) {
    case 'installing_python_packages':
      return i18nState.INSTALLATION_PROGRESS_PHASE_PYTHON || 'Installing Python packages'
    case 'installing_custom_nodes':
      return i18nState.INSTALLATION_PROGRESS_PHASE_NODES || 'Installing custom nodes'
    case 'stopping_backend':
      return i18nState.INSTALLATION_PROGRESS_PHASE_STOPPING || 'Stopping ComfyUI backend'
    case 'starting_backend':
      return i18nState.INSTALLATION_PROGRESS_PHASE_STARTING || 'Starting ComfyUI backend'
    case 'downloading_models':
      return i18nState.INSTALLATION_PROGRESS_PHASE_DOWNLOADING || 'Downloading models'
    case 'completed':
      return i18nState.INSTALLATION_PROGRESS_PHASE_COMPLETED || 'Installation completed'
    case 'error':
      return i18nState.INSTALLATION_PROGRESS_PHASE_ERROR || 'Installation error'
    default:
      return ''
  }
}

function closeDialog() {
  dialogStore.closeInstallationProgressDialog()
}
</script>
