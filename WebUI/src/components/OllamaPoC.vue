<template>
  <div
    v-if="textInference.backend === 'ollama'"
    id="chatPanel"
    class="p-4 chat-panel flex-auto flex flex-col gap-6 m-4 text-white overflow-y-scroll"
    :class="textInference.fontSizeClass"
    @scroll="props.onScroll"
  >
    <div v-if="ollama.ollamaDlProgress.status !== 'idle'">
      Ollama DL:
      {{
        `${((ollama.ollamaDlProgress.completedBytes ?? 0) / 1024 / 1024).toFixed(1)} MB  of ${((ollama.ollamaDlProgress.totalBytes ?? 0) / 1024 / 1024).toFixed(1)} MB`
      }}
    </div>
    <div v-for="message in ollama.messages" :key="message.id">
      {{ message.role === 'user' ? 'User: ' : 'AI: ' }}
      {{ message.parts }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { useOllama } from '@/assets/js/store/ollama'
import { useTextInference } from '@/assets/js/store/textInference'

const props = defineProps<{
  onScroll: (e: Event) => void
}>()
const textInference = useTextInference()
const ollama = useOllama()
</script>
