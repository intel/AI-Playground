<template>
    <div class="absolute left-0 top-0 cursor-none"
        :style="{ 'width': `${props.width}px`, 'height': `${props.height}px` }" @mouseenter="showShadow"
        @mousemove="moveWithShadow" @mouseleave="shadowPos.show = false">
        <canvas :width="props.width" :height="props.height" class="modify-mask" ref="modifyMask"></canvas>
        <span v-show="shadowPos.show" class="absolute bg-gray-500 pointer-events-none opacity-50 rounded-full"
            :style="{ 'width': `${props.brushSize}px`, 'height': `${props.brushSize}px`, 'transform': shadowPos.translate }"></span>
    </div>
</template>
<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n';

const props = defineProps<{
    width: number,
    height: number,
    brushSize: number,
    easerSize: number,
    mode: number
}>();

const modifyMask = ref<HTMLCanvasElement>();
const shadowPos = reactive({
    translate: "",
    show: false
});
onMounted(() => {
    modifyMask.value!.addEventListener("pointerdown", function (e) {
        const target = e.target as HTMLCanvasElement;
        drawModifyArea(e);
        target.setPointerCapture(e.pointerId);
        target.addEventListener("pointermove", drawModifyArea);
        target.addEventListener("pointerup", function () {
            modifyMask.value!.removeEventListener("pointermove", drawModifyArea);
        }, { once: true });
    });
});

function drawModifyArea(e: PointerEvent) {
    const x = e.x;
    const y = e.y;

    const canvas = e.target as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    if (x < rect.left || y < rect.top || x > rect.right || y > rect.bottom) {
        return;
    }
    const context = canvas.getContext("2d");
    const centerX = x - rect.left;
    const centerY = y - rect.top;
    if (context) {
        if (props.mode == 0) {
            context.globalCompositeOperation = 'source-over';
            context.beginPath();
            context.arc(centerX, centerY, props.brushSize / 2, 0, 2 * Math.PI);
            context.fillStyle = 'rgba(0,0,0)';
            context.fill();
            context.closePath();
        } else {
            // 设置混合模式为destination-out
            context.globalCompositeOperation = 'destination-out';
            context.beginPath();
            context.arc(centerX, centerY, props.easerSize / 2, 0, 2 * Math.PI);
            context.fill();
            context.closePath();
        }
    }
}

function clearMaskImage() {
    const canvas = modifyMask.value!;
    const rect = canvas!.getBoundingClientRect();
    const context = canvas.getContext("2d");
    if (context) {
        context.clearRect(0, 0, rect.width, rect.height);
    }
}

function getMaskImage() {
    const modifyCanvas = modifyMask.value!;
    const modifyCxt = modifyCanvas.getContext("2d");
    if (modifyCxt) {
        const imgData = modifyCxt.getImageData(0, 0, modifyCanvas.width, modifyCanvas.height);
        const flagArray = new Int8Array(imgData.data.length / 4);
        let noMask = true;
        for (let i = 0, j = 0; i < imgData.data.length; i += 4, j++) {
            if (imgData.data[i + 3] > 0) {
                flagArray[j] = 255;
                noMask = false;
            } else {
                flagArray[j] = 0;
            }
        }
        if (noMask) {
            throw new Error(useI18N().state.ENHANCE_INPAINT_MASK_REQUIRED);
        }
        return new Blob([flagArray.buffer]);
    }
    else {
        throw new Error("get mask image fail");
    }
}

function moveWithShadow(e: MouseEvent) {
    const radius = (props.mode == 0 ? props.brushSize : props.easerSize) / 2;
    shadowPos.translate = `translate(${e.offsetX - radius}px,${e.offsetY - radius}px)`;
}


function showShadow() {
    shadowPos.show = true;
}

defineExpose({ clearMaskImage, getMaskImage })
</script>
