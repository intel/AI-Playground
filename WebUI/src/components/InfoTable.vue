<template>
  <div
    v-if="props.generationParameters"
    class="info-params absolute px-5 pt-8 pb-5 text-white w-1000"
  >
    <button
      class="w-5 h-5 svg-icon i-close absolute right-2 top-2"
      @click="emits('close')"
    ></button>
    <div class="params-list">
      <ul class="border border-color-spilter">
        <li
          v-for="(value, key) in props.generationParameters"
          class="last:border-none border-b border-color-spilter flex items-center"
          :key="key"
        >
          <span class="text-base font-bold px-4 items-stretch w-36 flex-none">{{
            languages[key]
          }}</span>
          <img v-if="value.type === 'image'" :src="value.image" class="info-params-image" />
          <span v-else class="px-4 flex-auto break-word">{{ value }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
<script setup lang="ts">
const props = defineProps<{
  generationParameters: KVObject
}>()

const emits = defineEmits<{
  (e: 'close'): void
}>()
</script>
