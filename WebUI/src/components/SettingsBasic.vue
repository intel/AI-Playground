<template>
    <div class="flex flex-col gap-2">
        <p>{{ languages.SETTINGS_BASIC_LANGUAGE }}</p>
        <drop-selector :array="i18n.languageOptions" @change="i18n.changeLanguage">
            <template #selected>
                <div class="flex gap-2 items-center">
                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                    <span>{{ i18n.currentLanguageName }}</span>
                </div>
            </template>
            <template #list="slotItem">
                <div class="flex gap-2 items-center">
                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                    <span>{{ slotItem.item.name }}</span>
                </div>
            </template>
        </drop-selector>
    </div>
    <div v-if="theme.availableThemes.length > 1" class="flex flex-col gap-2">
        <p>Theme</p>
        <div class="grid gap-2" :class="{[`grid-cols-${theme.availableThemes.length}`]: true}">
            <radio-block v-for="themeName in theme.availableThemes" :checked="theme.active === themeName" :text="themeToDisplayName(themeName)"
                @click="() => theme.selected = themeName"></radio-block>
        </div>
    </div>
    <div class="flex flex-col gap-2">
        <p>{{ languages.SETTINGS_INFERENCE_DEVICE }}</p>
        <div class="flex items-center gap-2 flex-wrap">
            <drop-selector :array="globalSetup.graphicsList" @change="changeGraphics">
                <template #selected>
                    <div class="flex gap-2 items-center">
                        <span class="rounded-full bg-green-500 w-2 h-2"></span>
                        <span>{{ graphicsName }}</span>
                    </div>
                </template>
                <template #list="slotItem">
                    <div class="flex gap-2 items-center">
                        <span class="rounded-full bg-green-500 w-2 h-2"></span>
                        <span>{{ slotItem.item.name }}</span>
                    </div>
                </template>
            </drop-selector>
        </div>
    </div>
</template>
<script setup lang="ts">

import DropSelector from "../components/DropSelector.vue";
import RadioBlock from "../components/RadioBlock.vue";

import { useGlobalSetup } from "@/assets/js/store/globalSetup";
import { useI18N } from '@/assets/js/store/i18n';
import { useTheme } from '@/assets/js/store/theme';

const globalSetup = useGlobalSetup();
const i18n = useI18N();
const theme = useTheme();

const themeToDisplayName = (theme: Theme) => {
    switch (theme) {
        case 'dark': return 'Default';
        case 'lnl': return 'Intel® Core™ Ultra';
        case 'bmg': return 'Intel® Arc™';
        default: return theme;
    }
}

const modelSettings = reactive<KVObject>(Object.assign({}, toRaw(globalSetup.modelSettings)));

const graphicsName = computed(() => {
    return globalSetup.graphicsList.find(item => modelSettings.graphics as number == item.index)?.name || "";
})

function changeGraphics(value: any, index: number) {
    globalSetup.applyModelSettings({ graphics: (value as GraphicsItem).index });
}

</script>