<template>
    <div id="app-settings-panel"
        class="settings-panel absolute right-0 top-0 h-full bg-color-bg-main text-sm text-white py-4">
        <div class="flex justify-between items-center px-3">
            <div class="flex items-center gap-2">
                <button class="panel-tab" :class="{ 'active': tabIndex == 0 }" @click="tabIndex = 0">
                    {{ languages.SETTINGS_TAB_IMAGE }}
                </button>
                <button class="panel-tab" :class="{ 'active': tabIndex == 1 }" @click="tabIndex = 1">
                    {{ languages.SETTINGS_TAB_BASIC }}
                </button>
                <button class="panel-tab" :class="{ 'active': tabIndex == 2 }" @click="tabIndex = 2">
                    {{ languages.SETTINGS_TAB_MODEL }}
                </button>
            </div>
            <button class="w-6 h-6" @click="emits('close')">
                <span class="svg-icon i-right-arrow h-4 w-4"></span>
            </button>
        </div>
        <!--ImageSettingsTab-->
        <div v-show="tabIndex == 0" class="flex-auto h-0 flex flex-col gap-5 pt-3 border-t border-color-spilter overflow-y-auto">
            <div class="px-3 flex-none flex flex-col gap-3">
                <SettingsImageGeneration></SettingsImageGeneration>
            </div>
        </div>
        <!--BasicSettingsTab-->
        <div v-show="tabIndex == 1" class="flex-auto h-0 flex flex-col gap-5 pt-3 border-t border-color-spilter overflow-y-auto">
            <div class="px-3 flex-none flex flex-col gap-3">
                <SettingsBasic></SettingsBasic>
            </div>
        </div>
        <!--ModelSettingsTab-->
        <div v-show="tabIndex == 2" class="flex-auto h-0 flex flex-col gap-5 pt-3 border-t border-color-spilter overflow-y-auto">
            <div class="px-3 flex-none flex flex-col gap-3">
                <SettingsModel></SettingsModel>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">

import SettingsImageGeneration from "@/components/SettingsImageGeneration.vue";
import SettingsBasic from "@/components/SettingsBasic.vue";
import SettingsModel from "@/components/SettingsModel.vue";

const tabIndex = ref(0);

const emits = defineEmits<{
  (e: "close"): void
}>();

</script>