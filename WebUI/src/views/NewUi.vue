<template>
  <div id="new-ui" class="pt-10 text-white flex flex-col items-center gap-7 text-base">
      <textarea
        class="rounded-xl border border-color-spilter flex-auto h-full resize-none"
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
