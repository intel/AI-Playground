<template>
  <div>
    <h3 class="text-white mb-3">{{ languages.ENHANCE_COM_DENOISE }}</h3>
    <div class="gap-3 w-80">
      <slide-bar v-model:current="denoise" :min="0.1" :max="1" :step="0.01"></slide-bar>
    </div>
  </div>
</template>
<script setup lang="ts">
import SlideBar from './SlideBar.vue'

const denoise = ref(0.5)

const emits = defineEmits<{
  (e: 'disablePrompt', value: boolean): void
}>()

onMounted(() => {
  emits('disablePrompt', false)
})

function getParams() {
  return {
    denoise: denoise.value,
  }
}

defineExpose({
  getParams,
})
</script>
