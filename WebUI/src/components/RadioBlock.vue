<template>
    <button type="button" class="v-radio-block" :class="{ 'v-radio-block-checked': props.checked }" :disabled="props.disabled" @click="emits('click')">
        {{ props.text }}
    </button>
</template>
<script setup lang="ts">
const props = withDefaults(defineProps<{
    text: string,
    checked: boolean,
    disabled?: boolean,
}>(), {
    text: "",
    checked: false,
    disabled: false
});

const emits = defineEmits<{
    (e: "click"): void
}>();
</script>