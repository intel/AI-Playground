<template>
    <button ref="root" class="v-drop-select" :class="class" :disabled="props.disabled" @click="showList">
        <p class="v-drop-select-result">
            <span class="v-drop-select-text">
                <slot name="selected">{{ props.value == null ? languages.COM_NO_SELECTED : props.value }}</slot>
            </span>
            <span class="v-drop-toggle"></span>
        </p>
    </button>
    <Teleport to="#app">
        <ul ref="list" v-if="show" class="v-drop-select-list absolute left-0 top-0"
            :style="{ 'translate': translate, width: `${listRect.width}px` }">
            <li v-for="item, i in array" @click="changeSelectedItem(item, i)">
                <slot name="list" v-bind="{ item: item, index: i }">{{ item }}</slot>
            </li>
        </ul>
    </Teleport>
</template>
<script setup lang="ts">

const props = defineProps<{
    array: Array<any>,
    value?: any,
    emptyText?: string,
    disabled?: boolean
    class?: any
}>();
const root = ref<HTMLElement>();
const list = ref<HTMLElement>();
const show = ref(false);
const listRect = reactive({
    x: 0,
    y: 0,
    width: 0
});
let timerId = 0;
function updateTranslate() {
    const dropList = list.value!;
    if (dropList) {
        const rect = root.value!.getBoundingClientRect();
        listRect.x = rect.x;
        listRect.width = rect.right - rect.left;
        const appRect = document.body.getBoundingClientRect();
        if (dropList.clientHeight + rect.bottom + 5 >= appRect.bottom) {
            listRect.y = rect.top - dropList.clientHeight - 5;
        } else {
            listRect.y = rect.bottom + 5;
        }
    }
}

const translate = computed(() => {
    return `${listRect.x}px ${listRect.y}px`;
})


const watcher = watchEffect(() => {
    if (!show.value) {
        document.removeEventListener("wheel", wheelHide);
        document.body.removeEventListener("mousedown", addClickHide);
    }
})

onUnmounted(() => {
    watcher();
    document.body.removeEventListener("mousedown", addClickHide);
    document.removeEventListener("wheel", wheelHide);
})

function showList() {
    if (!props.disabled) {
        show.value = !show.value;
        if (show.value) {
            nextTick(() => {
                updateTranslate();
                document.body.addEventListener("mousedown", addClickHide);
                document.addEventListener("wheel", wheelHide);

            })
        } else {
            window.clearInterval(timerId);
        }
    }
}

function wheelHide(e: WheelEvent) {
    if (list.value) {
        const rect = list.value!.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
            show.value = false;
        }
    }
}

function addClickHide(e: MouseEvent) {
    const paths = e.composedPath();
    if (list.value && !paths.includes(list.value) && !paths.includes(root.value!)) {
        show.value = false;

    }
}

const emits = defineEmits<{
    (e: "change", value: any, index: number): void
}>();

function changeSelectedItem(item: any, index: number) {
    emits("change", item, index);
    show.value = false;
}
</script>
<style></style>