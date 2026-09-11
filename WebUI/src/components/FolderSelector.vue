<template>
  <div class="v-folder flex items-center gap-2 w-full">
    <input
      class="flex-auto v-folder-input"
      v-model="folder"
      type="text"
      :aria-label="fieldLabel"
      @change="emits('update:folder', folder)"
    />
    <button class="w-6 h-6" :aria-label="browseLabel" :title="browseLabel" @click="chooseFolder">
      <span class="svg-icon i-folder w-4 h-4"></span>
    </button>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import * as clientAPI from '@/assets/js/clientAPI'
import { useI18N } from '@/assets/js/store/i18n'

const props = defineProps<{
  folder: string
  /** Accessible name for the path field; also names the browse button. */
  label?: string
}>()

const i18nState = useI18N().state

// Callers that pass no `label` still need both controls named, so each falls back
// to the generic wording rather than to an empty accessible name.
const fieldLabel = computed(() => props.label ?? i18nState.COM_FOLDER_PATH)

const browseLabel = computed(() =>
  props.label
    ? (i18nState.COM_BROWSE_FOR ?? '').replace('{label}', props.label)
    : i18nState.COM_BROWSE,
)

const folder = ref(props.folder)

const watchFolder = watch(
  () => props.folder,
  (newVal) => {
    folder.value = newVal
  },
)

onUnmounted(() => {
  watchFolder()
})

const emits = defineEmits<{
  (e: 'update:folder', value: string): void
}>()

async function chooseFolder() {
  const result = await clientAPI.showOpenDialog({
    properties: ['openDirectory'],
    defaultPath: props.folder,
  })
  if (!result.canceled) {
    emits('update:folder', result.filePaths[0])
  }
}
</script>
