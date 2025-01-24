<template>
    <div class="v-loading">
        <p class="v-loading-text" v-html="util.html2Escape(porps.text)"></p>
        <div class="v-loading-bar">
            <div class="v-loading-bar-thumb">
            </div>
        </div>
    </div>
</template>
<script lang="ts" setup>
import * as util from '@/assets/js/util';

const porps = defineProps<{
    text: string
}>();
</script>