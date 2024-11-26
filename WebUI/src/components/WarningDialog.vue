<template>
    <div class="dialog-container z-10">
        <div class="dialog-mask absolute left-0 top-0 w-full h-full bg-black/55 flex justify-center items-center">
            <div class="py-10 px-20 w-500px flex flex-col items-center justify-center bg-gray-600 rounded-3xl gap-6 text-white"
                :class="{ 'animate-scale-in': animate }">
              <p v-html= "warningMessage"></p>
              <div class="flex justify-center items-center gap-9">
                <button @click="cancelConfirm" class="bg-color-control-bg  py-1 px-4 rounded">{{i18nState.COM_CANCEL}}</button>
                <button @click="confirmAdd" class="bg-color-control-bg  py-1 px-4 rounded">{{i18nState.COM_CONFIRM}}</button>
              </div>
            </div>
        </div>
    </div>
</template>
<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n.ts';
const i18nState = useI18N().state;
const confirmFunction = ref(() => {})
const warningMessage = ref("")
const animate = ref(false);
const emits = defineEmits<{
    (e: "close"): void
}>();


async function confirmAdd() {
  confirmFunction.value()
  emits("close");
}

function cancelConfirm() {
  emits("close");
}

function onShow(){
  animate.value = true
}

defineExpose({warningMessage, confirmFunction, onShow });

</script>