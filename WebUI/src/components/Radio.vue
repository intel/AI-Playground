<template>
    <button class="v-radio"  type="button" :disabled="props.disabled" 
            @click="emits('click')">
        <div class="v-radio-box"  :class="{ 'v-radio-checked': props.checked }">
            <span class="v-radio-cricle"></span>
        </div>
        <label class="v-radio-label">{{ props.text }}</label>
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