<template>
  <div class="rag-panel flex flex-col text-white" ref="dropZoneRef">
    <div
      class="flex justify-between items-center h-11 px-4 mb-3 border-b border-gray-200 text-sm w-full"
    >
      <span>{{ fileTotalText }}</span>
      <button
        class="svg-icon i-close w-5 h-5 hover:text-purple-500"
        @click="closeRagPanel"
      ></button>
    </div>
    <div v-show="textInference.ragList.length > 0" class="mx-2">
      <table class="w-full text-center">
        <tbody>
          <tr v-for="file in textInference.ragList" :key="file.hash" class="flex items-center mb-2">
            <td class="flex items-center justify-center w-[17%]">
              <input
                type="checkbox"
                class="w-4 h-4"
                :title="languages.COM_ADD_FILE_TO_RAG_CHECKBOX"
                v-model="file.isChecked"
                @change="textInference.updateFileCheckStatus(file.hash, file.isChecked)"
              />
            </td>
            <td class="text-left flex items-center gap-2 overflow-hidden w-[70%]">
              <span class="svg-icon flex-none w-5 h-5" :class="getIconClass(file.type)"></span>
              <div class="flex-grow text-ellipsis overflow-hidden" :title="file.filename">
                {{ file.filename }}
              </div>
            </td>
            <td class="flex items-center justify-center w-[13%]">
              <button
                class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center"
                :title="languages.COM_DELETE_FILE"
                @click="deleteFile(file.hash)"
              >
                <span class="svg-icon text-white i-delete w-4 h-4"></span>
              </button>
            </td>
          </tr>

          <tr class="flex border-t pt-3">
            <td class="flex items-center justify-center gap-1 w-[17%]">
              <button
                @click="textInference.checkAllFiles"
                :title="languages.COM_CHECK_ALL_FILES"
                class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center"
              >
                <span class="svg-icon text-white i-check w-4 h-4"></span>
              </button>
              <button
                @click="textInference.uncheckAllFiles"
                :title="languages.COM_UNCHECK_ALL_FILES"
                class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center"
              >
                <span class="svg-icon text-white i-uncheck w-4 h-4"></span>
              </button>
            </td>
            <td class="flex items-center justify-center w-[70%] pl-2">
              <button
                @click="chooseUploadFiles"
                :title="languages.COM_ADD_FILE_TO_RAG"
                class="bg-color-image-tool-button rounded-sm w-[90%] h-6 flex items-center justify-center"
              >
                <span class="svg-icon text-white i-add w-5 h-5"></span>
              </button>
            </td>
            <td class="flex items-center justify-center w-[13%]">
              <button
                @click="deleteAllFiles"
                :title="languages.COM_DELETE_ALL_FILES"
                class="bg-color-image-tool-button rounded-sm w-6 h-6 flex items-center justify-center"
              >
                <span class="svg-icon text-white i-clear w-4 h-4"></span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      v-show="textInference.ragList.length == 0"
      class="flex-auto h-0 flex flex-col items-center gap-2 justify-center text-gray-400 select-none"
    >
      <p class="text-lg font-bold" v-if="!globalSetup.state.isAdminExec">
        {{ i18nState.RAG_DRAG_UPLOAD }}
      </p>
      <pre class="text-xs" v-if="!globalSetup.state.isAdminExec">{{
        i18nState.RAG_UPLOAD_MIME_TYPE
      }}</pre>
      <p class="px-5" v-else>{{ i18nState.RAG_DRAG_UPLOAD_UNSUPPORTED }}</p>
      <button
        @click="chooseUploadFiles"
        :title="languages.COM_ADD_FILE_TO_RAG"
        class="bg-color-image-tool-button rounded-sm w-[270px] h-6 flex items-center justify-center"
      >
        <span class="svg-icon text-white i-add w-5 h-5"></span>
      </button>
    </div>
  </div>
  <div class="items-end justify-end"></div>
</template>
<script setup lang="ts">
import * as toast from '@/assets/js/toast'
import { useI18N } from '@/assets/js/store/i18n'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useTextInference } from '@/assets/js/store/textInference'
import * as clientAPI from '@/assets/js/clientAPI'
import { useDropZone } from '@vueuse/core'

import { ValidFileExtension, IndexedDocument } from '@/assets/js/store/textInference'

const globalSetup = useGlobalSetup()
const textInference = useTextInference()
const i18nState = useI18N().state
const dropZoneRef = ref<HTMLDivElement>()
const emits = defineEmits<{
  (e: 'close'): void
}>()
const fileTotalText = computed(() => {
  return i18nState.RAG_FILE_TOTAL_FORMAT.replace('{total}', textInference.ragList.length.toString())
})

function getIconClass(type: ValidFileExtension) {
  switch (type) {
    case 'txt':
      return 'i-txt'
    case 'doc':
    case 'docx':
      return 'i-doc'
    case 'md':
      return 'i-md'
    case 'pdf':
      return 'i-pdf'
    default:
      return 'i-txt'
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
    properties: ['openFile', 'multiSelections'],
  })
  if (!result.canceled) {
    addDocumentToRagList(result.filePaths)
  }
}

// does not work atm
function onDrop(files: File[] | null) {
  console.log('########')
  console.log(files)
  console.log('########')
}

// does not work atm
const { isOverDropZone } = useDropZone(dropZoneRef, {
  onDrop, // does not accept files because they are not local -> see LoadImage.vue
  dataTypes: [
    'application/pdf',
    'text/plain',
    'text/x-markdown', //not working for whatever reason
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  multiple: true,
  preventDefaultForUnhandled: false,
})

async function addDocumentToRagList(filePaths: string[]) {
  for (let filePath of filePaths) {
    console.log(filePath)
    const name = filePath.split(/(\\|\/)/g).pop()
    const ext = name?.split('.').pop() as ValidFileExtension | undefined
    if (!name || !ext) {
      toast.error(i18nState.RAG_UPLOAD_TYPE_ERROR)
      continue
    }
    const newDocument: IndexedDocument = {
      filename: name,
      filepath: filePath,
      type: ext,
      splitDB: [],
      hash: '',
      isChecked: true,
    }
    await textInference.addDocumentToRagList(newDocument)
  }
}

function deleteFile(hash: string) {
  textInference.deleteFile(hash)
}

function deleteAllFiles() {
  textInference.deleteAllFiles()
}

function closeRagPanel() {
  emits('close')
}
</script>
