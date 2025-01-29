<template>
  <div class="v-folder flex items-center gap-2 w-full">
    <input
      class="flex-auto v-folder-input"
      v-model="folder"
      type="text"
      @change="emits('update:folder', folder)"
    />
    <button class="w-6 h-6" @click="chooseFolder">
      <span class="svg-icon i-folder w-4 h-4"></span>
    </button>
  </div>
</template>
<script setup lang="ts">
import * as clientAPI from '@/assets/js/clientAPI'

const props = defineProps<{
  folder: string
}>()

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
