<template>
  <div class="v-checkbox" type="button" :disabled="props.disabled">
    <button
      class="v-checkbox-control flex-none"
      :class="{ 'v-checkbox-checked': props.checked }"
      @click="emits('update:checked', !props.checked)"
    ></button>
    <label class="v-checkbox-label">{{ props.text }}</label>
  </div>
</template>
<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    text: string
    checked: boolean
    disabled?: boolean
  }>(),
  {
    text: '',
    checked: false,
    disabled: false,
  },
)

const emits = defineEmits<{
  (e: 'update:checked', value: boolean): void
}>()
</script>
