<template>
  <div id="new-ui" class="text-white flex flex-col items-center justify-center gap-7 text-base">
    <p class="text-2xl font-bold">
      Let's Generate
    </p>
      <textarea
        class="rounded-2xl resize-none w-full max-w-3xl h-48"
        :placeholder="languages.COM_LLM_PROMPT"
        v-model="question"
        @keydown="fastGenerate"
      ></textarea>
  </div>
</template>

<script setup lang="ts">

const question = ref('')

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
