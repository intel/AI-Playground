<template>
  <div id="new-ui" class="text-white flex flex-col items-center justify-center gap-7 text-base">
    <p class="text-2xl font-bold">
      Let's Generate
    </p>
    <div class="relative w-full max-w-3xl">
      <textarea
        class="rounded-2xl resize-none w-full h-48 pb-16"
        :placeholder="languages.COM_LLM_PROMPT"
        v-model="question"
        @keydown="fastGenerate"
      ></textarea>
      <div class="absolute bottom-3 left-3 flex gap-2">
        <button
          @click="currentMode = 'chat'"
          :class="currentMode === 'chat' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600'"
          class="px-3 py-1.5 rounded-lg text-sm"
        >
          Chat
        </button>
        <button
          @click="currentMode = 'imageGen'"
          :class="currentMode === 'imageGen' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600'"
          class="px-3 py-1.5 rounded-lg text-sm"
        >
          Image Gen
        </button>
        <button
          @click="currentMode = 'imageEdit'"
          :class="currentMode === 'imageEdit' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600'"
          class="px-3 py-1.5 rounded-lg text-sm"
        >
          Image Edit
        </button>
        <button
          @click="currentMode = 'video'"
          :class="currentMode === 'video' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600'"
          class="px-3 py-1.5 rounded-lg text-sm"
        >
          Video
        </button>
      </div>

      <div class="absolute bottom-3 right-3 flex gap-2">
        <button class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm">
          Button 5
        </button>
        <button class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm">
          Button 6
        </button>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">

const question = ref('')
const currentMode = ref('chat')

function fastGenerate(e: KeyboardEvent) {
  console.log(e.key)

  // if (e.code == 'Enter') {
  //   if (processing.value) {
  //     return
  //   }
  //
  //   if (e.ctrlKey || e.shiftKey || e.altKey) {
  //     question.value += '\n'
  //   } else {
  //     e.preventDefault()
  //     if (question.value !== '') {
  //       newPromptGenerate()
  //     }
  //   }
  // }
}

onMounted(() => {
  document
    .getElementById('new-ui')!
    .querySelectorAll('a')
    .forEach((item) => {
      item.addEventListener('click', function (e) {
        e.preventDefault()
        window.electronAPI.openUrl(this.href as string)
        return false
      })
    })
})
</script>
