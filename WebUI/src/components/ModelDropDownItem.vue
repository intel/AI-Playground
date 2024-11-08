<template>
    <div class="flex gap-2 items-center overflow-hidden text-ellipsis">
        <span class="rounded-full w-2 h-2 flex-shrink-0"  :class="{ 'bg-green-500': model.downloaded, 'bg-gray-500': !model.downloaded }" ></span>
        <span class="h-7 overflow-hidden">{{ model.name }}</span>
    </div>
</template>
<script setup lang="ts">
import { type Model } from "../assets/js/store/models";

const props = withDefaults(defineProps<{
    model: Model
}>(), {
    model: () => ({
        name: "model not found",
        type: "llm",
        downloaded: false
    })
});

</script>