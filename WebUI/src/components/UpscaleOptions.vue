<template>
  <div>
    <h3 class="text-white mb-3">{{ languages.ENHANCE_UPSCALE_SCALE }}</h3>
    <div class="gap-3 w-80 flex-wrap grid grid-cols-2">
      <radio
        :checked="scale == 0"
        :text="languages.ENHANCE_UPSCALE_SCALE_X1_5"
        @click="changeScale(0)"
      ></radio>
      <radio
        :checked="scale == 1"
        :text="languages.ENHANCE_UPSCALE_SCALE_X2_0"
        @click="changeScale(1)"
      ></radio>
    </div>
  </div>
  <div :class="{'demo-number-overlay' : true}">
    <span class="demo-vertical-line"></span>
    <h3 class="text-white mb-3">{{ languages.ENHANCE_UPSCALE_VARIATION }}</h3>
    <div class="gap-3 w-80">
      <slide-bar v-model:current="denoise" :min="0" :max="1" :step="0.01"></slide-bar>
    </div>
    <div v-if="true" class="demo-step-number">2</div>
  </div>
</template>
<script setup lang="ts">
import Radio from './Radio.vue'
import SlideBar from './SlideBar.vue'

const scale = ref(0)
const denoise = ref(0)
const emits = defineEmits<{
  (e: 'disablePrompt', value: boolean): void
}>()

onMounted(() => {
  emits('disablePrompt', false)
})

function changeScale(value: number) {
  scale.value = value
}

function getParams() {
  return {
    scale: scale.value == 0 ? 1.5 : 2,
    denoise: denoise.value,
  }
}

defineExpose({
  getParams,
})
</script>
