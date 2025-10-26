<template>
  <div class="flex flex-col h-full items-center ml-auto mr-auto">
    <div
      id="chatPanel"
      class="p-4 chat-panel flex-auto flex flex-col gap-6 m-4 text-white overflow-y-scroll"
      :class="textInference.fontSizeClass"
      @scroll="props.onScroll"
    >
      <div class="max-w-512px" v-for="message in llamaCpp.messages" :key="message.id">
        <span class="text-xl font-extrabold">{{ message.role === 'user' ? 'User' : 'AI' }}</span>
        <div v-for="part in message.parts" :key="part.type">
          <span v-if="part.type === 'reasoning'">Reasoning: {{ part.text }}<br /></span>
          <span v-else-if="part.type === 'text'">{{ part.text }}</span>
          <img
            v-else-if="part.type === 'file' && part.mediaType.startsWith('image/')"
            :src="part.url"
            alt="Generated Image"
          />
        </div>
      </div>
    </div>
    <div class="min-w-512px px-4 pb-4">
      <InputGroup>
        <InputGroupTextarea v-model="llamaCpp.messageInput" placeholder="Ask, Search or Chat..." />
        <InputGroupAddon align="block-end">
          <img
            v-for="preview in imagePreview"
            :key="preview.id"
            :src="preview.url"
            alt="Image Preview"
            class="max-h-12 max-w-12 mr-2 rounded"
          />
          <InputGroupButton variant="outline" class="rounded-full cursor-pointer" size="icon-xs">
            <Label htmlFor="image"><PlusIcon class="size-4 cursor-pointer" /></Label>
            <Input
              type="file"
              class="hidden"
              id="image"
              @change="llamaCpp.fileInput = $event.target.files"
            />
          </InputGroupButton>
          <InputGroupButton
            variant="default"
            class="rounded-full ml-auto"
            size="icon-xs"
            @click="llamaCpp.generate()"
          >
            <ArrowUpIcon class="size-4" />
            <span class="sr-only">Send</span>
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { PlusIcon, ArrowUpIcon } from '@heroicons/vue/24/outline'
import { useLlamaCpp } from '@/assets/js/store/llamaCpp'
import { useTextInference } from '@/assets/js/store/textInference'

const props = defineProps<{
  onScroll: (e: Event) => void
}>()
const textInference = useTextInference()
const llamaCpp = useLlamaCpp()

const imagePreview = computed(() => {
  if (llamaCpp.fileInput) {
    const urls = []
    let id = 0
    for (const file of llamaCpp.fileInput) {
      const url = URL.createObjectURL(file)
      urls.push({ id, url })
      id++
    }
    return urls
  }
  return []
})
</script>
