<template>
    <div class="h-full flex flex-col">
    <div class="flex flex-auto items-center justify-center">
        <img src=""/>
    </div>
    <div class="h-64 flex-none">
        <p class="text-color-gray-666 text-sm">{{ languages.COM_PROMPT }}</p>
        <div class="flex justify-between items-center">
            <textarea class="rounded-xl border border-color-spilter w-full bg-transparent text-white p-4 focus:border-purple-500"></textarea>
        </div>
    </div>
</div>
</template>
<script setup lang="ts">
import { useI18N } from "@/assets/js/store/i18n.ts";

useI18N();
</script>