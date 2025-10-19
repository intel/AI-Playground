<template>
  <div
    v-if="textInference.backend === 'llamaCPP'"
    id="chatPanel"
    class="p-4 chat-panel flex-auto flex flex-col gap-6 m-4 text-white overflow-y-scroll"
    :class="textInference.fontSizeClass"
    @scroll="props.onScroll"
  >
    Lllama CPP Chat:
    <div v-for="message in llamaCpp.messages" :key="message.id">
      <span class="text-xl font-extrabold">{{ message.role === 'user' ? 'User' : 'AI' }}</span>
      <div v-for="part in message.parts" :key="part.type">
        <span v-if="part.type === 'reasoning'">Reasoning: {{ part.text }}<br /></span>
        <span v-else-if="part.type === 'text'">{{ part.text }}</span>
        <img v-else-if="part.type === 'file' && part.mediaType.startsWith('image/')" :src="part.url" alt="Generated Image" />
        <span v-else>Other parts: {{ JSON.stringify(part) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useLlamaCpp } from '@/assets/js/store/llamaCpp';
import { useTextInference } from '@/assets/js/store/textInference'

const props = defineProps<{
  onScroll: (e: Event) => void
}>()
const textInference = useTextInference()
const llamaCpp = useLlamaCpp()
</script>
