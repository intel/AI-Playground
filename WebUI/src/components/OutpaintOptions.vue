<template>
  <div
    class="flex items-center gap-2 text-white"
    :class="{ 'demo-mode-outpaint-content': demoMode.enabled && demoMode.enhance.showOutpaint }"
  >
    <div class="flex flex-col gap-2 items-center text-center">
      <span>{{ languages.ENHANCE_OUTPAINT_DIRECTION }}</span>
    </div>
    <div class="outpaint-control flex items-center justify-center">
      <div class="outpaint-control-bg">
        <button
          class="outpaint-drieciton top"
          :class="{ active: direction == 'top' }"
          @click="toggleDirection('top')"
        ></button>
        <button
          class="outpaint-drieciton right"
          :class="{ active: direction == 'right' }"
          @click="toggleDirection('right')"
        ></button>
        <button
          class="outpaint-drieciton bottom"
          :class="{ active: direction == 'bottom' }"
          @click="toggleDirection('bottom')"
        ></button>
        <button
          class="outpaint-drieciton left"
          :class="{ active: direction == 'left' }"
          @click="toggleDirection('left')"
        ></button>
      </div>
    </div>
    <div v-if="demoMode.enabled && demoMode.enhance.showOutpaint" class="demo-step-number">2</div>
  </div>
  <div
    class="flex flex-col gap-8 text-white"
    :class="{ 'demo-mode-denoise-content': demoMode.enabled && demoMode.enhance.showOutpaint }"
  >
    <div class="flex gap-3 items-center">
      <span class="w-28 flex-none">{{ languages.ENHANCE_COM_DENOISE }}</span>
      <div class="w-80">
        <slide-bar
          v-model:current="denoise"
          :min="0.1"
          :max="1"
          :step="0.01"
          :show-tip="true"
        ></slide-bar>
      </div>
    </div>
    <div v-if="demoMode.enabled && demoMode.enhance.showOutpaint" class="demo-step-number">3</div>
  </div>
</template>
<script setup lang="ts">
import { useDemoMode } from '@/assets/js/store/demoMode'
import SlideBar from './SlideBar.vue'

const demoMode = useDemoMode()

const direction = ref<string>('right')
const denoise = ref(0.99)
const emits = defineEmits<{
  (e: 'disablePrompt', value: boolean): void
}>()

onMounted(() => {
  emits('disablePrompt', false)
})
function toggleDirection(value: string) {
  direction.value = value
}

function getParams() {
  return {
    direction: direction.value,
    denoise: denoise.value,
  }
}

defineExpose({
  getParams,
})
</script>
