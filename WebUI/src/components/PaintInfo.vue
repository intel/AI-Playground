<template>
  <div class="info-params absolute px-5 pt-8 pb-5 text-white">
    <button
      class="w-5 h-5 svg-icon i-close absolute right-2 top-2"
      @click="emits('close')"
    ></button>
    <div class="params-list">
      <ul class="border border-color-spilter">
        <li
          v-for="(v, k) in props.params"
          class="last:border-none border-b border-color-spilter flex items-start"
          :key="k"
        >
          <span class="text-base font-bold px-4 items-stretch w-36 flex-none">{{ k }}</span>
          <span class="px-4 flex-auto break-word">{{ getModeText(k as string, v) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'

const props = defineProps<{
  params: KVObject
}>()

const i18n = useI18N().state

const emits = defineEmits<{
  (e: 'close'): void
}>()

function getModeText(key: string, value: number | string) {
  if (key != 'mode') {
    return value.toString()
  }
  switch (value) {
    case 0:
      return i18n.TAB_CREATE
    case 1:
      return i18n.ENHANCE_UPSCALE
    case 2:
      return i18n.ENHANCE_IMAGE_PROMPT
    case 3:
      return i18n.ENHANCE_INPAINT
    case 4:
      return i18n.ENHANCE_OUTPAINT
    default:
      return 'unkonw'
  }
}
</script>
