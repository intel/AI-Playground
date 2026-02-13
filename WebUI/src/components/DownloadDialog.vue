<template>
  <div class="dialog-container z-50">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/55 flex justify-center items-center"
    >
      <div
        class="py-20 px-20 min-w-768px flex flex-col items-center justify-center bg-card rounded-3xl gap-8 text-foreground"
        :class="{ 'animate-scale-in': animate }"
      >
        <div v-if="showConfirm" class="text-center flex items-center flex-col gap-5">
          <p>{{ i18nState.DOWNLOADER_CONFRIM_TIP }}</p>
          <table class="text-left w-full">
            <thead>
              <tr class="text-center text-muted-foreground font-bold">
                <td class="text-left">{{ languages.DOWNLOADER_MODEL }}</td>
                <td>{{ languages.DOWNLOADER_FILE_SIZE }}</td>
                <td>{{ languages.DOWNLOADER_GATED }}</td>
                <td>{{ languages.DOWNLOADER_INFO }}</td>
                <td>{{ languages.DOWNLOADER_LICENSE }}</td>
                <td>{{ languages.DOWNLOADER_REASON }}</td>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in downloadModelRender" :key="item.repo_id">
                <td>{{ item.repo_id }}</td>
                <td>
                  <div class="flex flex-col items-center">
                    <span v-if="sizeRequesting" class="svg-icon i-loading w-4 h-4"></span>
                    <span v-else>{{ item.size }}</span>
                  </div>
                </td>
                <td>
                  <div class="flex flex-col items-center">
                    <span v-if="sizeRequesting" class="svg-icon i-loading w-4 h-4"></span>
                    <div v-else>
                      <svg
                        v-if="item.gated"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke-width="1"
                        stroke="currentColor"
                        class="size-6 ml-2"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
                        />
                      </svg>
                      <svg
                        v-else
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke-width="1"
                        stroke="currentColor"
                        class="size-6 ml-2"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
                        />
                      </svg>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="flex flex-col items-center">
                    <a
                      :href="getInfoUrl(item.repo_id, item.type)"
                      target="_blank"
                      class="text-primary text-sm"
                    >
                      {{ i18nState.DOWNLOADER_TERMS }}
                    </a>
                  </div>
                </td>
                <td>
                  <div
                    class="flex flex-col items-center"
                    v-if="item.additionalLicenseLink !== undefined"
                  >
                    <a
                      :href="item.additionalLicenseLink"
                      target="_blank"
                      class="text-primary text-sm"
                    >
                      {{ i18nState.DOWNLOADER_TERMS }}
                    </a>
                  </div>
                  <div class="flex flex-col items-center" v-else>-</div>
                </td>
                <td class="items-center text-sm text-green-400">
                  {{ getFunctionTip(item.type) }}
                </td>
              </tr>
            </tbody>
          </table>
          <div
            v-if="
              downloadModelRender.some((i) => i.gated && !i.accessGranted) &&
              downloadModelRender.length === 1
            "
            class="flex flex-col items-center gap-2 p-4 border border-red-600 bg-red-600/10 rounded-lg"
          >
            <span class="font-bold mx-4">{{ languages.DOWNLOADER_ACCESS_INFO_SINGLE }}</span>
            <span class="text-left">
              {{ !models.hfTokenIsValid ? languages.DOWNLOADER_GATED_TOKEN : '' }}
              {{
                downloadModelRender.some((i) => i.gated)
                  ? languages.DOWNLOADER_GATED_ACCEPT_SINGLE
                  : ''
              }}
              {{
                downloadModelRender.some((i) => !i.accessGranted)
                  ? languages.DOWNLOADER_ACCESS_ACCEPT_SINGLE
                  : ''
              }}
            </span>
          </div>
          <div
            v-if="
              downloadModelRender.some((i) => i.gated && !i.accessGranted) &&
              downloadModelRender.length > 1
            "
            class="flex flex-col items-center gap-2 p-4 border border-red-600 bg-red-600/10 rounded-lg"
          >
            <span class="font-bold mx-4">{{ languages.DOWNLOADER_ACCESS_INFO }}</span>
            <span class="text-left">
              {{ !models.hfTokenIsValid ? languages.DOWNLOADER_GATED_TOKEN : '' }}
              {{
                downloadModelRender.some((i) => i.gated) ? languages.DOWNLOADER_GATED_ACCEPT : ''
              }}
              {{
                downloadModelRender.some((i) => !i.accessGranted)
                  ? languages.DOWNLOADER_ACCESS_ACCEPT
                  : ''
              }}
            </span>
          </div>
          <label class="flex items-center gap-2">
            <Checkbox v-model="readTerms" />
            <span class="text-sm text-left">{{ languages.DOWNLOADER_TERMS_TIP }}</span>
          </label>
          <div class="flex justify-center items-center gap-9">
            <button @click="cancelConfirm" class="bg-muted text-foreground py-1 px-4 rounded">
              {{ i18nState.COM_CANCEL }}
            </button>
            <button
              @click="confirmDownload"
              :disabled="
                sizeRequesting || !readTerms || downloadModelRender.every((i) => !i.accessGranted)
              "
              class="bg-primary py-1 px-4 rounded"
            >
              {{ i18nState.COM_CONFIRM }}
            </button>
          </div>
        </div>
        <div v-else-if="hashError" class="flex flex-col items-center justify-center gap-4">
          <p>{{ errorText }}</p>
          <button @click="close" class="bg-red-500 py-1 px-4">{{ i18nState.COM_CLOSE }}</button>
        </div>
        <template v-else>
          <progress-bar :text="allDownloadTip" :percent="taskPercent" class="w-3/4"></progress-bar>
          <progress-bar :text="curDownloadTip" :percent="percent" class="w-3/4"></progress-bar>
          <button @click="cancelDownload" class="bg-red-500 py-1 px-4">
            {{ i18nState.COM_CANCEL }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, toRaw } from 'vue'
import { storeToRefs } from 'pinia'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import ProgressBar from './ProgressBar.vue'
import { Checkbox } from '@/components/ui/checkbox'
import { useI18N } from '@/assets/js/store/i18n'
import { SSEProcessor } from '@/assets/js/sseProcessor'
import * as util from '@/assets/js/util'
import * as toast from '@/assets/js/toast'
import { useModels } from '@/assets/js/store/models'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'

const i18nState = useI18N().state
const globalSetup = useGlobalSetup()
const models = useModels()
const dialogStore = useDialogStore()

const { downloadDialogVisible, downloadList, downloadSuccessFunction, downloadFailFunction } =
  storeToRefs(dialogStore)

let downloding = false
const curDownloadTip = ref('')
const allDownloadTip = ref('')
const percent = ref(0)
const completeCount = ref(0)
const taskPercent = ref(0)
const showConfirm = ref(false)
const sizeRequesting = ref(false)
const hashError = ref(false)
const errorText = ref('')
let abortController: AbortController
const animate = ref(false)
const readTerms = ref(false)
const downloadModelRender = ref<DownloadModelRender[]>([])

function dataProcess(line: string) {
  console.log(line)
  const dataJson = line.slice(5)
  const data = JSON.parse(dataJson) as LLMOutCallback
  switch (data.type) {
    case 'download_model_progress':
      curDownloadTip.value = `${i18nState.COM_DOWNLOAD_MODEL} ${data.repo_id}\r\n${data.download_size}/${data.total_size} ${data.percent}% ${i18nState.COM_DOWNLOAD_SPEED}: ${data.speed}`
      percent.value = data.percent
      break
    case 'download_model_completed':
      completeCount.value++
      const allTaskCount = downloadModelRender.value.length
      if (completeCount.value == allTaskCount) {
        downloding = false
        dialogStore.closeDownloadDialog()
        downloadSuccessFunction.value?.()
      } else {
        taskPercent.value = util.toFixed((completeCount.value / allTaskCount) * 100, 1)
        percent.value = 100
        allDownloadTip.value = `${i18nState.DOWNLOADER_DONWLOAD_TASK_PROGRESS} ${completeCount.value}/${allTaskCount}`
      }
      models.refreshModels()
      break
    case 'allComplete':
      downloding = false
      dialogStore.closeDownloadDialog()
      break
    case 'error':
      hashError.value = true
      abortController?.abort()
      fetch(`${globalSetup.apiHost}/api/stopDownloadModel`)

      switch (data.err_type) {
        case 'not_enough_disk_space':
          errorText.value = i18nState.ERR_NOT_ENOUGH_DISK_SPACE.replace(
            '{requires_space}',
            data.requires_space,
          ).replace('{free_space}', data.free_space)
          break
        case 'download_exception':
          errorText.value = i18nState.ERR_DOWNLOAD_FAILED
          break
        case 'runtime_error':
          errorText.value = i18nState.ERROR_RUNTIME_ERROR
          break
        case 'unknown_exception':
          errorText.value = i18nState.ERROR_GENERATE_UNKONW_EXCEPTION
          break
      }

      downloadFailFunction.value?.({ type: 'error', error: errorText.value })
      break
  }
}

watch(downloadDialogVisible, async (isVisible) => {
  if (isVisible) {
    nextTick(() => {
      animate.value = true
    })
    await initializeDownloadDialog()
    animate.value = false
  }
})

async function initializeDownloadDialog() {
  if (downloding) {
    toast.error(i18nState.DOWNLOADER_CONFLICT)
    downloadFailFunction.value?.({ type: 'conflict' })
    dialogStore.closeDownloadDialog()
    return
  }

  sizeRequesting.value = true
  curDownloadTip.value = i18nState.DOWNLOADER_CONFRIM_TIP
  showConfirm.value = true
  hashError.value = false
  percent.value = 0
  taskPercent.value = 0
  downloadModelRender.value = downloadList.value.map((item) => {
    return { size: '???', ...item }
  })
  readTerms.value = false

  try {
    const sizeResponse = await fetch(`${globalSetup.apiHost}/api/getModelSize`, {
      method: 'POST',
      body: JSON.stringify(downloadList.value),
      headers: {
        'Content-Type': 'application/json',
      },
    })
    const gatedResponse = await fetch(`${globalSetup.apiHost}/api/isModelGated`, {
      method: 'POST',
      body: JSON.stringify(downloadList.value),
      headers: {
        'Content-Type': 'application/json',
      },
    })
    const accessResponse = await fetch(`${globalSetup.apiHost}/api/isAccessGranted`, {
      method: 'POST',
      body: JSON.stringify([downloadList.value, models.hfToken]),
      headers: {
        'Content-Type': 'application/json',
      },
    })
    const sizeData = (await sizeResponse.json()) as ApiResponse & { sizeList: StringKV }
    const gatedData = (await gatedResponse.json()) as ApiResponse & {
      gatedList: Record<string, boolean>
    }
    const accessData = (await accessResponse.json()) as ApiResponse & {
      accessList: Record<string, boolean>
    }
    for (const item of downloadModelRender.value) {
      item.size = sizeData.sizeList[`${item.repo_id}_${item.type}`] || ''
      item.gated = gatedData.gatedList[item.repo_id] || false
      item.accessGranted = accessData.accessList[item.repo_id] || false
    }
    sizeRequesting.value = false
  } catch (ex) {
    downloadFailFunction.value?.({ type: 'error', error: ex })
    sizeRequesting.value = false
  }
}

function getInfoUrl(repoId: string, type: string) {
  if (type === 'upscale') {
    return 'https://github.com/xinntao/Real-ESRGAN'
  }

  switch (repoId) {
    case 'Lykon/dreamshaper-8':
      return 'https://huggingface.co/spaces/CompVis/stable-diffusion-license'
    case 'Lykon/dreamshaper-8-inpainting':
      return 'https://huggingface.co/spaces/CompVis/stable-diffusion-license'
    case 'RunDiffusion/Juggernaut-XL-v9':
      return 'https://huggingface.co/spaces/CompVis/stable-diffusion-license'
    case 'microsoft/Phi-3-mini-4k-instruct':
      return 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct/resolve/main/LICENSE'
    case 'BAAI/bge-large-en-v1.5':
      return 'https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/mit.md'
    case 'latent-consistency/lcm-lora-sdv1-5':
      return 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md'
    case 'latent-consistency/lcm-lora-sdxl':
      return 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md'
  }

  return `https://huggingface.co/${repoId.split('/').slice(0, 2).join('/')}`
}

function getFunctionTip(type: string): string {
  switch (type) {
    case 'llm':
      return i18nState.DOWNLOADER_FOR_ANSWER_GENERATE
    case 'embedding':
      return i18nState.DOWNLOADER_FOR_RAG_QUERY
    default:
      return 'Undefined'
  }
}

function download() {
  downloding = true
  const accessableDownloadList = downloadModelRender.value.filter(
    (item) => item.accessGranted === true,
  )
  allDownloadTip.value = `${i18nState.DOWNLOADER_DONWLOAD_TASK_PROGRESS} 0/${accessableDownloadList.length}`
  percent.value = 0
  completeCount.value = 0
  abortController = new AbortController()
  curDownloadTip.value = ''
  fetch(`${globalSetup.apiHost}/api/downloadModel`, {
    method: 'POST',
    body: JSON.stringify(toRaw({ data: accessableDownloadList })),
    headers: {
      'Content-Type': 'application/json',
      ...(models.hfTokenIsValid ? { Authorization: `Bearer ${models.hfToken}` } : {}),
    },
    signal: abortController.signal,
  })
    .then((response) => {
      const reader = response.body!.getReader()
      return new SSEProcessor(reader, dataProcess, undefined).start()
    })
    .catch((ex) => {
      downloadFailFunction.value?.({ type: 'error', error: ex })
      downloding = false
    })
}

function cancelConfirm() {
  downloadFailFunction.value?.({ type: 'cancelConfrim' })
  dialogStore.closeDownloadDialog()
}

function confirmDownload() {
  showConfirm.value = false
  hashError.value = false
  return download()
}

function cancelDownload() {
  abortController?.abort()
  fetch(`${globalSetup.apiHost}/api/stopDownloadModel`)
  downloadFailFunction.value?.({ type: 'cancelDownload' })
  dialogStore.closeDownloadDialog()
}

function close() {
  dialogStore.closeDownloadDialog()
}
</script>

<style scoped>
table {
  border-collapse: separate;
  border-spacing: 10px;
}
</style>
