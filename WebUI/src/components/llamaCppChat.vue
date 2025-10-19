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
      {{ message.role === 'user' ? 'User: ' : 'AI: ' }}
      {{ message.parts }}
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
