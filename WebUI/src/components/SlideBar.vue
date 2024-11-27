<script lang="ts" setup>
import { ref, computed } from 'vue';
let draging = false;
const props = withDefaults(defineProps<{
    current: number,
    step: number,
    min?: number,
    max?: number,
    disabled?: boolean,
    showTip?: boolean,
}>(), {
    current: 0,
    step: 1,
    min: 0,
    max: 100,
    disabled: false,
    showTip: false
});

const decimalScale = computed(() => getDecimalPlaces(props.step));

const step = computed(() => props.step * decimalScale.value);

const min = computed(() => props.min * decimalScale.value);

const max = computed(() => props.max * decimalScale.value);

const current = computed(() => props.current * decimalScale.value);

const emits = defineEmits<{
    (e: 'update:current', value: number): void
}>();
const per = computed(() => {
    //JS的浮点数精度泪流满面，全部转换为整数计算
    return `${Math.round(current.value - min.value) / (max.value - min.value) * 100}%`;
});

const slibarLeft = computed(() => {
    return `calc(${per.value} - 6px)`;
});

const position = ref<HTMLDivElement>();

function getDecimalPlaces(num: number) {
    let decimalPlaces = 0;
    while (num < 1) {
        decimalPlaces++;
        num *= 10;
    }
    return decimalPlaces == 0 ? 1 : Math.pow(10, decimalPlaces);
}

function getPercentRealVal(per: number): number {
    if (per <= 0) { return props.min; }
    else if (per >= 1) { return props.max; }
    const testVal = min.value + (max.value - min.value) * per;
    let left = min.value;
    let right = left;
    while (left < max.value) {
        right += step.value;
        if (left == testVal) {
            return left / decimalScale.value;
        }
        else if (right > testVal) {
            return Math.floor(Math.abs(testVal - right) < Math.abs(testVal - left)
                ? right : left) / decimalScale.value;
        }
        left = right;
    }
    return props.max;
}

function dragStart(e: PointerEvent) {
    if (props.disabled) {
        return;
    }
    const div = position.value!;
    upadteX(e.clientX);
    div.onpointermove = dragMove;
    div.onpointerup = dragEnd;
    div.setPointerCapture(e.pointerId);
    draging = true;
};

function upadteX(curX: number) {
    const rect = position.value!.getBoundingClientRect();
    let value: number;
    if (curX <= rect.x) {
        value = props.min;
    } else if (curX >= rect.right) {
        value = props.max;
    } else {
        value = getPercentRealVal((curX - rect.x) / rect.width);
        if (value < props.min) {
            console.log(`error value:${value}. curx:${curX}, rectX:${rect.x}`);
        }
    }
    emits('update:current', value);
}

function dragMove(e: PointerEvent) {
    if (props.disabled) {
        return;
    }
    upadteX(e.clientX);
};

function dragEnd(e: PointerEvent) {
    position.value!.onpointermove = null;
    position.value!.onpointerup = null;
    upadteX(e.clientX);
};

function inputChange(e: Event) {
    const target = (e.target as HTMLInputElement);
    const match = /^-?[0-9]+(\.[0-9]*)?/.exec(target.value);
    if (match) {
        target.value = match[0];
    }
}

function changeLimit(e: Event) {
    const target = (e.target as HTMLInputElement);
    let numVal = parseFloat(target.value);
    if (numVal < props.min) {
        numVal = props.min;
    } else if (numVal > props.max) {
        numVal = props.max;
    }
    emits("update:current", numVal);
}

</script>
<template>
    <div class="v-horizontal-slide" :class="{ 'disabled': disabled }">
        <div class="v-slide-container relative">
            <div class="v-slide-position" ref='position' @pointerdown="dragStart">
                <div class="v-slide-bg">
                    <i class="v-slide-bg-mask" :style="{ 'width': per }"></i>
                </div>
                <div class="v-slide-bar" :style="{ 'left': slibarLeft }"></div>
            </div>
            <div v-if="showTip" class="text-white absolute top-full left-0 w-full self-stretch flex justify-between text-xs">
                <span>{{languages.COM_LOW}}</span>
                <span>{{languages.COM_HIGH}}</span>
            </div>
        </div>
        <input :disabled="props.disabled" class="v-slide-val" :value="props.current" type="text" @input="inputChange" @change="changeLimit" />
    </div>
</template>