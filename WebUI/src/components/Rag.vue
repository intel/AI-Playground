<template>
  <div
    class="rag-panel flex flex-col text-foreground bg-background rounded-xl p-4"
    :class="{ 'border-2 border-dashed border-primary bg-primary/10': isOverDropZone }"
    ref="dropZoneRef"
  >
    <!-- Header -->
    <div
      class="flex justify-between items-center h-11 px-4 mb-3 border-b border-border text-sm w-full"
    >
      <span class="text-lg font-bold">{{ languages.RAG_SEARCHABLE_DOCUMENTS }}</span>
      <button
        class="svg-icon i-close w-7 h-7 hover:text-primary transition-colors duration-200"
        @click="closeRagPanel"
      ></button>
    </div>

    <!-- File List -->
    <div v-show="textInference.ragList.length > 0" class="mx-2 flex flex-col">
      <!-- File Items -->
      <div
        v-for="file in textInference.ragList"
        :key="file.hash"
        class="flex items-center mb-2 py-1 px-2 hover:bg-primary/20 rounded-lg transition-colors duration-200"
      >
        <!-- Checkbox (aligned left) -->
        <div class="w-[10%] flex justify-start pl-2">
          <input
            type="checkbox"
            class="w-5 h-5 accent-primary"
            :title="languages.COM_ADD_FILE_TO_RAG_CHECKBOX"
            v-model="file.isChecked"
            @change="textInference.updateFileCheckStatus(file.hash, file.isChecked)"
          />
        </div>

        <!-- File Name (aligned left with icon) -->
        <div class="w-[75%] flex items-center gap-2">
          <span class="svg-icon flex-none w-5 h-5" :class="getIconClass(file.type)"></span>
          <div class="truncate" :title="file.filepath">
            {{ file.filename }}
          </div>
        </div>

        <!-- Delete Button (aligned right) -->
        <div class="w-[15%] flex justify-end pr-2">
          <button
            class="bg-muted rounded-xs w-6 h-6 flex items-center justify-center hover:bg-red-700/50 transition-colors duration-200"
            :title="languages.COM_DELETE_FILE"
            @click="deleteFile(file.hash)"
          >
            <span class="svg-icon text-foreground i-delete w-4 h-4"></span>
          </button>
        </div>
      </div>

      <!-- Bottom Controls -->
      <div class="flex items-center border-t border-border py-1 px-2 pt-3 mt-2">
        <!-- Three-state Checkbox (aligned left) -->
        <div class="w-[10%] flex justify-start pl-2">
          <input
            type="checkbox"
            class="w-5 h-5 accent-primary"
            :checked="selectionState === 'all'"
            @change="toggleSelectionState"
            ref="selectAllCheckbox"
          />
        </div>

        <!-- Add Files Button (centered) -->
        <div class="w-[60%] flex justify-center">
          <button
            @click="chooseUploadFiles"
            :title="languages.COM_ADD_FILE_TO_RAG"
            class="bg-primary rounded-sm px-4 h-8 flex items-center justify-center hover:bg-primary/80 transition-colors duration-200"
          >
            <span class="svg-icon text-foreground i-add w-5 h-5 mr-2"></span>
            <span>{{ languages.RAG_ADD_FILES }}</span>
          </button>
        </div>

        <!-- Clear All Button (aligned right) -->
        <div class="w-[30%] flex justify-end pr-2">
          <button
            @click="deleteAllFiles"
            :title="languages.COM_DELETE_ALL_FILES"
            class="bg-muted/50 rounded-sm px-2 h-8 flex items-center justify-center hover:bg-destructive/50 transition-colors duration-200"
          >
            <span class="svg-icon text-foreground i-delete w-4 h-4 mr-1"></span>
            <span class="text-xs">{{ languages.RAG_CLEAR_ALL }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <div
      v-show="textInference.ragList.length == 0"
      class="flex-auto h-0 flex flex-col items-center gap-4 justify-center text-muted-foreground select-none p-10"
    >
      <div class="w-20 h-20 rounded-full bg-primary/30 flex items-center justify-center">
        <span class="svg-icon i-upload w-10 h-10"></span>
      </div>
      <p class="text-lg font-bold" v-if="!globalSetup.state.isAdminExec">
        {{ i18nState.RAG_DRAG_UPLOAD }}
      </p>
      <pre class="text-xs bg-background/20 p-2 rounded" v-if="!globalSetup.state.isAdminExec">{{
        i18nState.RAG_UPLOAD_MIME_TYPE
      }}</pre>
      <p class="px-5" v-else>{{ i18nState.RAG_DRAG_UPLOAD_UNSUPPORTED }}</p>
      <button
        @click="chooseUploadFiles"
        :title="languages.COM_ADD_FILE_TO_RAG"
        class="bg-primary py-2 px-6 rounded-sm hover:bg-primary/80 transition-colors duration-200 flex items-center justify-center gap-2"
      >
        <span class="svg-icon text-foreground i-add w-5 h-5"></span>
        <span>{{ languages.RAG_ADD_FILES }}</span>
      </button>
    </div>
  </div>
</template>
<script setup lang="ts">
import * as toast from '@/assets/js/toast'
import { useI18N } from '@/assets/js/store/i18n'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useTextInference } from '@/assets/js/store/textInference'
import * as clientAPI from '@/assets/js/clientAPI'
import { useDropZone } from '@vueuse/core'
import { ref, computed, watch, onMounted } from 'vue'

import { ValidFileExtension, IndexedDocument } from '@/assets/js/store/textInference'

const globalSetup = useGlobalSetup()
const textInference = useTextInference()
const i18nState = useI18N().state
const dropZoneRef = ref<HTMLDivElement>()
const selectAllCheckbox = ref<HTMLInputElement | null>(null)
const emits = defineEmits<{
  (e: 'close'): void
}>()

// Computed property to determine the selection state (all, some, none)
const selectionState = computed(() => {
  if (!textInference.ragList.length) return 'none'
  const checkedCount = textInference.ragList.filter((file) => file.isChecked).length
  if (checkedCount === 0) return 'none'
  if (checkedCount === textInference.ragList.length) return 'all'
  return 'some'
})

// Function to toggle selection state
function toggleSelectionState() {
  switch (selectionState.value) {
    case 'none':
    case 'some':
      textInference.checkAllFiles()
      break
    case 'all':
      textInference.uncheckAllFiles()
      break
  }
}

// Watch for changes in selection state to update the indeterminate property
watch(selectionState, (newState) => {
  if (selectAllCheckbox.value) {
    selectAllCheckbox.value.indeterminate = newState === 'some'
  }
})

// Update the indeterminate state when the component is mounted
onMounted(() => {
  if (selectAllCheckbox.value) {
    selectAllCheckbox.value.indeterminate = selectionState.value === 'some'
  }
})

function getIconClass(type: ValidFileExtension) {
  switch (type) {
    case 'doc':
    case 'docx':
      return 'i-word'
    case 'md':
      return 'i-md'
    case 'pdf':
      return 'i-pdf'
    case 'txt':
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
    addDocumentsToRagList(result.filePaths)
  }
}

function onDrop(files: File[] | null) {
  console.log('onDrop', files)
  if (!files) return
  const filePaths = files.map((file) => window.electronAPI.getFilePath(file))
  const validExtensions = ['txt', 'doc', 'docx', 'md', 'pdf']
  const fileExtensions = filePaths.map((filePath) => filePath.split('.').pop() ?? '')
  if (fileExtensions.some((ext) => !validExtensions.includes(ext))) {
    toast.error(i18nState.RAG_UPLOAD_TYPE_ERROR)
    return
  }
  addDocumentsToRagList(filePaths)
}

const { isOverDropZone } = useDropZone(dropZoneRef, {
  onDrop,
  multiple: true,
  preventDefaultForUnhandled: false,
})

async function addDocumentsToRagList(filePaths: string[]) {
  for (const filePath of filePaths) {
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
