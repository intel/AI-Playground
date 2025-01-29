<template>
  <div class="flex justify-center gap-8 h-full text-white">
    <div class="flex items-center gap-5 flex-none">
      <span>{{ languages.ENHANCE_INPAINT_TYPE }}</span>
      <div class="flex items-center gap-2">
        <radio-block
          :checked="paintType == 1"
          :text="languages.ENHANCE_INPAINT_FIX"
          @click="updateType(1)"
        ></radio-block>
        <radio-block
          :checked="paintType == 0"
          :text="languages.ENHANCE_INPAINT_FILL"
          @click="updateType(0)"
        ></radio-block>
      </div>
    </div>
    <div class="flex items-center gap-5 flex-none">
      <span>{{ languages.ENHANCE_COM_DENOISE }}</span>
      <div class="flex-col gap-3 w-80">
        <slide-bar
          v-model:current="denoise"
          :min="0.1"
          :max="1"
          :step="0.01"
          :show-tip="true"
        ></slide-bar>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import RadioBlock from './RadioBlock.vue'
import SlideBar from './SlideBar.vue'

const paintType = ref(1)
const denoise = ref(0.35)
const emits = defineEmits<{
  (e: 'disablePrompt', value: boolean): void
}>()

onMounted(() => {
  emits('disablePrompt', paintType.value == 1)
})

function getParams() {
  return {
    mask_op: paintType.value,
    denoise: denoise.value,
  }
}
function updateType(value: number) {
  paintType.value = value
  if (value == 0) {
    //fill and replace, denoise init_image
    denoise.value = 0.85
  } else {
    //fix and redo, less denoised
    denoise.value = 0.35
  }
}

defineExpose({
  getParams,
})
</script>
