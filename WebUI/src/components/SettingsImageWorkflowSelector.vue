<template>
  <dialog
    ref="hdConfirmationDialog"
    class="bg-gray-600 max-w-md p-7 items-center justify-center rounded-lg shadow-lg text-white"
  >
    <form method="dialog" class="items-center justify-center">
      <p class="mb-4">
        {{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_HD_CONFIRM }}
      </p>
      <div class="flex justify-between space-x-4 items-center">
        <button class="bg-slate-700 py-1 px-4 rounded">
          {{ languages.COM_CANCEL }}
        </button>
        <div class="flex-end space-x-4">
          <button
            @click="
              () => {
                hdWarningOverride = true
                classicModel = 'sdxl'
              }
            "
            class="bg-color-active py-1 px-4 rounded"
          >
            {{ languages.COM_CONFIRM }}
          </button>
          <button
            @click="
              () => {
                imageGeneration.hdWarningDismissed = true
                classicModel = 'sdxl'
              }
            "
            class="bg-blue-500 py-1 px-4 rounded"
          >
            {{ languages.COM_DO_NOT_SHOW_AGAIN }}
          </button>
        </div>
      </div>
    </form>
  </dialog>
  <comfy-u-i-download-dialog
    v-show="showComfyUIDownloadDialog"
    @close="onComfyUIDialogClose"
  ></comfy-u-i-download-dialog>
  <div class="items-center flex-wrap grid grid-cols-1 gap-2">
    <div class="flex flex-col gap-2">
      <p>{{ languages.SETTINGS_IMAGE_MODE }}</p>
      <div class="grid grid-cols-2 items-center gap-2 flex-wrap">
        <radio-block
          :checked="imageGeneration.backend === 'default'"
          :text="languages.SETTINGS_IMAGE_DEFAULT"
          @click="
            () => {
              imageGeneration.backend = 'default'
            }
          "
        ></radio-block>
        <radio-block
          :checked="imageGeneration.backend === 'comfyui'"
          :text="languages.SETTINGS_IMAGE_WORKFLOW"
          @click="
            () => {
              onSwitchToComfyUI()
            }
          "
        ></radio-block>
      </div>
    </div>
    <div v-if="imageGeneration.backend === 'default'" class="flex flex-col gap-2">
      <p>{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION }}</p>
      <div class="grid grid-cols-3 items-center gap-2 flex-wrap">
        <radio-block
          :checked="classicModel === 'sd1.5'"
          :text="languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STANDARD"
          @click="
            () => {
              classicModel = 'sd1.5'
            }
          "
        ></radio-block>
        <radio-block
          :checked="classicModel === 'sdxl'"
          :text="languages.SETTINGS_MODEL_IMAGE_RESOLUTION_HD"
          @click="
            () => {
              classicModel = 'sdxl'
            }
          "
        ></radio-block>
        <radio-block
          :checked="classicModel === 'manual'"
          :text="languages.SETTINGS_MODEL_QUALITY_MANUAL"
          @click="
            () => {
              classicModel = 'manual'
            }
          "
        ></radio-block>
      </div>
    </div>
    <div v-if="imageGeneration.backend === 'default'" class="flex flex-col gap-2">
      <p>{{ languages.SETTINGS_MODEL_QUALITY }}</p>
      <div class="grid grid-cols-3 items-center gap-2 flex-wrap">
        <radio-block
          :checked="classicQuality === 'standard'"
          :text="languages.SETTINGS_MODEL_QUALITY_STANDARD"
          @click="
            () => {
              classicQuality = 'standard'
            }
          "
          :disabled="classicModel === 'manual'"
        ></radio-block>
        <radio-block
          :checked="classicQuality === 'hq'"
          :text="languages.SETTINGS_MODEL_QUALITY_HIGH"
          @click="
            () => {
              classicQuality = 'hq'
            }
          "
          :disabled="classicModel === 'manual'"
        ></radio-block>
        <radio-block
          :checked="classicQuality === 'fast'"
          :text="languages.SETTINGS_MODEL_QUALITY_FAST"
          @click="
            () => {
              classicQuality = 'fast'
            }
          "
          :disabled="classicModel === 'manual'"
        ></radio-block>
      </div>
    </div>
    <div v-if="imageGeneration.backend === 'comfyui'" class="flex flex-col gap-2">
      <div class="flex justify-between items-center pt-3">
        <p>{{ languages.SETTINGS_IMAGE_WORKFLOW }}</p>
        <p
          class="select-none"
          v-show="imageGeneration.activeWorkflow.requirements?.includes('high-vram')"
          :data-tooltip="i18nState.WORKFLOW_HIGH_VRAM_INFO"
        >
          <span
            class="svg-icon text-purple-500 align-bottom i-warning-triangle w-5 h-5 px-3"
          ></span>
          {{ languages.WORKFLOW_HIGH_VRAM_WARNING }}
        </p>
      </div>
      <div class="flex gap-2 items-center">
        <drop-selector
          :array="
            imageGeneration.workflows.filter((w) => w.backend === 'comfyui').sort(highToLowPrio)
          "
          @change="(workflow) => (imageGeneration.activeWorkflowName = workflow.name)"
        >
          <template #selected>
            <div class="flex gap-2 items-center">
              <span class="rounded-full bg-green-500 w-2 h-2"></span>
              <span>{{ imageGeneration.activeWorkflowName }}</span>
              <span
                class="rounded-lg h-4 px-1 text-xs"
                :style="{ 'background-color': `${stringToColour(tag)}88` }"
                v-for="tag in imageGeneration.activeWorkflow.tags"
                :key="tag"
              >
                {{ tag }}</span
              >
            </div>
          </template>
          <template #list="slotItem">
            <div class="flex gap-2 items-center">
              <span class="rounded-full bg-green-500 w-2 h-2"></span>
              <span>{{ slotItem.item.name }}</span>
              <span
                class="rounded-lg h-4 px-1 text-xs"
                :style="{ 'background-color': `${stringToColour(tag)}88` }"
                v-for="tag in slotItem.item.tags"
                :key="tag"
              >
                {{ tag }}</span
              >
            </div>
          </template>
        </drop-selector>
        <div :data-tooltip="i18nState.WORKFLOW_RELOAD_INFO">
          <button
            class="svg-icon i-refresh w-5 h-5 text-purple-500"
            @click="imageGeneration.loadWorkflowsFromJson"
          ></button>
        </div>
        <div :data-tooltip="i18nState.WORKFLOW_DOWNLOAD_INFO">
          <button
            class="svg-icon i-download-cloud w-5 h-5 text-purple-500"
            @click="loadWorkflowsFromIntel"
          ></button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ComfyUiWorkflow, useImageGeneration } from '@/assets/js/store/imageGeneration'
import DropSelector from '../components/DropSelector.vue'
import RadioBlock from '../components/RadioBlock.vue'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import ComfyUIDownloadDialog from '@/components/ComfyUIDownloadDialog.vue'
import * as toast from '@/assets/js/toast'
import { useI18N } from '@/assets/js/store/i18n.ts'
const i18nState = useI18N().state

const imageGeneration = useImageGeneration()
const backendServices = useBackendServices()

const hdConfirmationDialog = ref<HTMLDialogElement>()
const hdWarningOverride = ref(false)

const showComfyUIDownloadDialog = ref(false)

const classicModel = computed({
  get() {
    if (imageGeneration.activeWorkflowName === 'Standard') {
      return 'sd1.5'
    }
    if (imageGeneration.activeWorkflowName === 'Manual') {
      return 'manual'
    }
    if (imageGeneration.activeWorkflowName?.includes('HD')) {
      return 'sdxl'
    }
    return 'sd1.5'
  },
  set(newValue) {
    if (newValue === 'manual') {
      imageGeneration.activeWorkflowName = 'Manual'
      return
    }
    if (newValue === 'sdxl' && !imageGeneration.hdWarningDismissed && !hdWarningOverride.value) {
      hdConfirmationDialog.value?.showModal()
      return
    } else {
      hdWarningOverride.value = false
    }
    const targetWorkflow =
      imageGeneration.workflows.find(
        (w) =>
          w.tags.includes(newValue) &&
          (classicQuality.value === 'standard' || w.tags.includes(classicQuality.value)),
      )?.name ?? 'Standard'
    imageGeneration.activeWorkflowName = targetWorkflow
  },
})

function onSwitchToComfyUI() {
  if (backendServices.info.find((s) => s.serviceName === 'comfyui-backend')?.status === 'running') {
    imageGeneration.backend = 'comfyui'
  } else {
    showComfyUIDownloadDialog.value = true
  }
}

function onComfyUIDialogClose() {
  showComfyUIDownloadDialog.value = false
}

async function loadWorkflowsFromIntel() {
  const syncStatus = await imageGeneration.loadWorkflowsFromIntel()
  if (syncStatus.success) {
    toast.error(`Backed up models at ${syncStatus.backupDir}`)
  } else {
    toast.error('Synchronisation failed')
  }
}

const classicQuality = computed({
  get() {
    if (!imageGeneration.activeWorkflowName?.match(/(Standard|HD)/)) {
      return 'standard'
    }
    if (imageGeneration.activeWorkflowName?.includes('High Quality')) {
      return 'hq'
    }
    if (imageGeneration.activeWorkflowName?.includes('Fast')) {
      return 'fast'
    }
    return 'standard'
  },
  set(newValue) {
    if (newValue === 'standard') {
      imageGeneration.activeWorkflowName =
        imageGeneration.workflows.find(
          (w) =>
            w.tags.includes(classicModel.value) &&
            !w.tags.includes('hq') &&
            !w.tags.includes('fast'),
        )?.name ?? 'Standard'
    }
    if (newValue === 'hq') {
      imageGeneration.activeWorkflowName =
        imageGeneration.workflows.find(
          (w) => w.tags.includes(classicModel.value) && w.tags.includes('hq'),
        )?.name ?? 'Standard'
    }
    if (newValue === 'fast') {
      imageGeneration.activeWorkflowName =
        imageGeneration.workflows.find(
          (w) => w.tags.includes(classicModel.value) && w.tags.includes('fast'),
        )?.name ?? 'Standard'
    }
  },
})

const highToLowPrio = (a: ComfyUiWorkflow, b: ComfyUiWorkflow) =>
  b.displayPriority - a.displayPriority

const stringToColour = (str: string) => {
  const colors = [
    '#ff00ff', // Magenta
    '#ff33cc', // Light Magenta
    '#cc00ff', // Purple
    '#9900ff', // Dark Purple
    '#6600ff', // Indigo
    '#3300ff', // Blue
    '#00ccff', // Light Blue
    '#00ffff', // Cyan
  ]

  let hash = 0
  str.split('').forEach((char) => {
    hash = char.charCodeAt(0) + ((hash << 5) - hash)
  })

  // Use the hash to select a color from the palette
  const index = Math.abs(hash) % colors.length
  return colors[index]
}
</script>

<style>
[data-tooltip]:hover::after {
  display: block;
  position: absolute;
  right: 10px;
  content: attr(data-tooltip);
  border: 1px solid rgb(122, 122, 122);
  background: rgba(41, 41, 41, 0.95);
  border-radius: 0.5rem;
  padding: 0.7em;
  z-index: 10;
}
</style>
