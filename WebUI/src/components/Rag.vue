<template>
  <div class="rag-panel flex flex-col text-white">
    <div
      class="rag-header flex justify-between items-center h-11 px-4 border-b border-gray-200 text-sm"
    >
      <span>{{ fileTotalText }}</span>
      <div class="flex items-center gap-2">
        <button
          class="svg-icon i-add-box w-5 h-5 text-white hover:text-purple-500"
          @click="chooseUploadFiles"
        ></button>
        <button
          class="svg-icon i-close w-5 h-5 hover:text-purple-500"
          @click="closeRagPanel"
        ></button>
      </div>
    </div>
    <div
      class="flex-auto overflow-y-auto px-4 py-2"
      v-show="fileTotal > 0"
      @drop="dropFileToUpload"
      @dragover="dragOverHandler"
    >
      <div v-for="item in fileList" class="flex items-center gap-2 justify-center w-full h-8">
        <span class="svg-icon flex-none w-5 h-5" :class="getIconClass(item.type)"></span>
        <div class="flex-grow line2 overflow-hidden text-ellipsis h-6" :title="item.filename">
          {{ item.filename }}
        </div>
        <span class="svg-icon i-queue flex-none w-5 h-5" v-if="item.status == 0"> </span>
        <span class="svg-icon i-loading flex-none w-5 h-5" v-else-if="item.status == 1"> </span>
        <button
          class="svg-icon i-delete flex-none w-5 h-5 hover:text-red-500"
          v-if="item.status == 2"
          :disabled="opLocker"
          @click="deleteFile(item)"
        ></button>
      </div>
    </div>
    <div
      v-show="fileTotal == 0"
      class="flex-auto h-0 flex flex-col items-center gap-2 justify-center text-gray-400 select-none"
      @dragover="dragOverHandler"
      @drop="dropFileToUpload"
    >
      <p class="text-lg font-bold" v-if="!globalSetup.state.isAdminExec">
        {{ i18nState.RAG_DRAG_UPLOAD }}
      </p>
      <pre class="text-xs" v-if="!globalSetup.state.isAdminExec">{{
        i18nState.RAG_UPLOAD_MIME_TYPE
      }}</pre>
      <p class="px-5" v-else>{{ i18nState.RAG_DRAG_UPLOAD_UNSUPPORTED }}</p>
    </div>
  </div>
</template>
<script setup lang="ts">
import * as toast from '@/assets/js/toast'
import { useI18N } from '@/assets/js/store/i18n'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import * as clientAPI from '@/assets/js/clientAPI'

const globalSetup = useGlobalSetup()
const i18nState = useI18N().state
const emits = defineEmits<{
  (e: 'update:useRag', newVal: boolean): void
  (e: 'close'): void
}>()
const fileList = ref<Array<RagFileItem>>([])
const fileTotal = computed(() => fileList.value.length)
const fileTotalText = computed(() => {
  return i18nState.RAG_FILE_TOTAL_FORMAT.replace('{total}', fileTotal.value.toString())
})
const opLocker = ref(false)
let uploadWorking = false

onBeforeMount(() => {
  getIndexFiles()
})

function getIconClass(type: number) {
  switch (type) {
    case 2:
      return 'i-word'
    case 3:
      return 'i-ppt'
    case 4:
      return 'i-pdf'
    case 5:
      return 'i-md'
    default:
      return 'i-txt'
  }
}

function getFileType(ext: string) {
  switch (ext) {
    case '.md':
      return 5
    case '.pdf':
      return 4
    case '.ppt':
    case '.pptx':
      return 3
    case '.doc':
    case '.docx':
      return 2
    default:
      return 1
  }
}

async function getIndexFiles() {
  const response = await fetch(`${globalSetup.apiHost}/api/llm/getRagFiles`)
  const rspJson = (await response.json()) as ApiResponse & {
    data: { filename: string; md5: string }[]
  }
  if (rspJson.code == 0 && rspJson.data) {
    fileList.value = rspJson.data.map((item) => {
      const idx = item.filename.lastIndexOf('.')
      const ext = idx > -1 ? item.filename.substring(idx) : ''
      return {
        type: getFileType(ext),
        filename: item.filename,
        md5: item.md5,
        status: 2,
      }
    })
  }
}

async function chooseUploadFiles() {
  const result = await clientAPI.showOpenDialog({
    filters: [
      { name: 'all files', extensions: ['txt', 'doc', 'docx', 'md', 'pdf'] },
      { name: 'text files', extensions: ['txt'] },
      { name: 'doc files', extensions: ['doc', 'docx'] },
      { name: 'md files', extensions: ['md'] },
      { name: 'pdf files', extensions: ['pdf'] },
    ],
  })
  if (!result.canceled) {
    addFilesToWorkQueue(result.filePaths)
  }
}

function dragOverHandler(ev: DragEvent) {
  ev.preventDefault()
}

function dropFileToUpload(e: DragEvent) {
  if (e.dataTransfer && e.dataTransfer.files) {
    const fileList = new Array<string>()
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      fileList.push(e.dataTransfer.files.item(i)!.path)
    }
    addFilesToWorkQueue(fileList)
  }
}

function addFilesToWorkQueue(filePaths: string[]) {
  let valid = true
  let successCount = 0
  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i]
    console.log(filePath)
    const idx = filePath.lastIndexOf('.')
    if (idx > -1) {
      const ext = filePath.substring(idx)
      if (!/\.(docx?|txt|pdf|md)$/i.test(ext)) {
        valid = false
        continue
      } else {
        fileList.value.push({
          type: getFileType(ext),
          filename: filePath.substring(filePath.lastIndexOf('\\') + 1),
          md5: '',
          status: 0,
          path: filePath,
        })
        successCount++
      }
    }
  }
  if (!valid) {
    toast.error(i18nState.RAG_UPLOAD_TYPE_ERROR)
  }
  if (successCount && !uploadWorking) {
    startUpload()
  }
}

async function startUpload() {
  uploadWorking = true
  while (true) {
    const fileItem = fileList.value.find((item) => item.status == 0)
    if (fileItem == null) {
      break
    }
    if (fileItem.path) {
      try {
        fileItem.status = 1
        const formData = new FormData()
        formData.append('path', fileItem.path)
        const response = await fetch(`${globalSetup.apiHost}/api/llm/uploadRagFile`, {
          method: 'post',
          body: formData,
        })
        const result = (await response.json()) as ApiResponse & { md5: string }
        if (result.code == 0) {
          fileItem.status = 2
          fileItem.md5 = result.md5
          fileItem.path = null
          continue
        } else if (result.code == 1) {
          toast.warning(i18nState.RAG_UPLOAD_FILE_EXISTS.replace('{filename}', fileItem.filename))
        } else {
          toast.error(i18nState.RAG_ANALYZE_FILE_FAILED.replace('{filename}', fileItem.filename))
        }
      } catch (ex) {
        console.log(ex)
        toast.error(i18nState.RAG_ANALYZE_FILE_FAILED.replace('{filename}', fileItem.filename))
      }
      fileList.value = fileList.value.filter((item) => item != fileItem)
    }
  }
  uploadWorking = false
}

async function deleteFile(index: RagFileItem) {
  if (opLocker.value) {
    return
  }
  try {
    opLocker.value = true
    const formData = new FormData()
    formData.append('md5', index.md5)
    const response = await fetch(`${globalSetup.apiHost}/api/llm/deleteRagIndex`, {
      method: 'POST',
      body: formData,
    })
    const rspData = (await response.json()) as ApiResponse
    if (rspData.code == 0) {
      fileList.value = fileList.value.filter((item) => item != index)
      if (fileList.value.length == 0) {
        emits('update:useRag', false)
      }
    }
  } finally {
    opLocker.value = false
  }
}

function closeRagPanel() {
  if (uploadWorking) {
    toast.warning(i18nState.RAG_WHEN_CLOSE_PANEL_AT_UPLODING)
    return
  }
  emits('close')
}
</script>
