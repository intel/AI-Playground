<template>
    <div class="v-random">
        <input class="v-random-input" type="text" v-model="generatedNumber" @input="inputValidate" />
        <div class="v-random-btns">
            <button class="w-6 h-6 rounded flex justify-center items-center bg-color-control-bg" @click="generateRandom"
                :title="languages.COM_REGENERATE">
                <span class="svg-icon i-dice text-white w-4 h-4"></span>
            </button>
            <button class="w-6 h-6 rounded  flex justify-center items-center bg-color-control-bg" @click="resetToDefault"
                :title="languages.COM_RESET">
                <span class="svg-icon i-reset text-white w-4 h-4"></span>
            </button>
        </div>
    </div>
</template>
<script lang="ts" setup>
const props = withDefaults(defineProps<{
    min: number,
    max: number,
    scale: number,
    default: number,
    value: number,
}>(), {
    min: 0,
    max: 100,
    scale: 1,
    default: -1,
    value: -1,

});


const emits = defineEmits(["update:value", "change:current"]);

const generatedNumber = ref(props.value.toString());

const watchVal = watchEffect(() => {
    generatedNumber.value = props.value.toString();
})

onUnmounted(() => {
    watchVal();
})

function inputValidate() {
    const newValue = parseInt(generatedNumber.value);
    if (!isNaN(newValue)) {
        emits("update:value", newValue);
        emits("change:current", newValue);
    }
    
}


function generateRandom() {
    const randomValue = Math.floor(Math.random() * (props.max - props.min + 1)) + props.min;
    generatedNumber.value = randomValue.toString();
    emits("update:value", randomValue);
    emits("change:current", randomValue);
}

function resetToDefault() {
    generatedNumber.value = props.default.toString();
    emits("update:value", props.default);
    emits("change:current", props.default);
}

</script>