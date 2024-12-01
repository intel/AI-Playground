<template>
    <div class="flex flex-col gap-2">
        <WorkflowSelector />
        <div class="items-center flex-wrap grid grid-cols-1 gap-2">
            <div class="flex flex-col gap-2">
                <ResolutionPicker v-if="modifiableOrDisplayed('resolution')" :disabled="!modifiable('resolution')" />
            </div>
            <div class="flex items-center gap-5">
                <p>{{ languages.SETTINGS_MODEL_IMAGE_PREVIEW }}</p>
                <button v-show=true class="v-checkbox-control flex-none w-5 h-5"
                    :class="{ 'v-checkbox-checked': imageGeneration.imagePreview }"
                    @click="() => imageGeneration.imagePreview = !imageGeneration.imagePreview">
                </button>
            </div>
            <div v-if="modifiableOrDisplayed('inferenceSteps')" class="flex flex-col gap-2">
                <p>{{ languages.SETTINGS_MODEL_IMAGE_STEPS }}</p>
                <slide-bar v-model:current="imageGeneration.inferenceSteps" :min="1" :max="50" :step="1"
                    :disabled="!modifiable('inferenceSteps')"></slide-bar>
            </div>
            <div v-if="modifiableOrDisplayed('seed') || imageGeneration.activeWorkflow.displayedSettings.includes('seed')"
                class="flex flex-col gap-2">
                <p>{{ languages.SETTINGS_MODEL_SEED }}</p>

                <random-number v-model:value="imageGeneration.seed" :default="-1" :min="0" :max="4294967295"
                    :disabled="!modifiable('seed')" :scale="1"></random-number>
            </div>
            <div v-if="modifiableOrDisplayed('batchSize')" class="flex flex-col gap-2">
                <p>{{ languages.SETTINGS_MODEL_GENERATE_NUMBER }}</p>
                <slide-bar v-model:current="imageGeneration.batchSize" :min="1" :max="4" :step="1"
                    :disabled="!modifiable('batchSize')"></slide-bar>
            </div>
            <div v-if="modifiableOrDisplayed('negativePrompt')" class="flex flex-col gap-2">
                <p>{{ languages.SETTINGS_MODEL_NEGATIVE_PROMPT }}</p>
                <textarea :disabled="!modifiable('negativePrompt')" class="h-32 rounded-lg resize-none"
                    v-model="imageGeneration.negativePrompt"></textarea>
            </div>
            <h2 v-if="anyModifiableOrDisplayed(['width', 'height', 'scheduler', 'guidanceScale', 'imageModel', 'inpaintModel', 'lora'])" class="text-center font-bold">{{ languages.SETTINGS_MODEL_MANUAL_OPTIONS }}</h2>
            <div v-if="modifiableOrDisplayed('width')" class="flex flex-col gap-2">
                <p>{{ languages.SETTINGS_MODEL_IMAGE_WIDTH }}</p>
                <slide-bar v-model:current="imageGeneration.width" :min="256" :max="2048" :step="64"
                    :disabled="!modifiable('width')"></slide-bar>
            </div>
            <div v-if="modifiableOrDisplayed('height')" class="flex flex-col gap-2">
                <p>{{ languages.SETTINGS_MODEL_IMAGE_HEIGHT }}</p>
                <slide-bar v-model:current="imageGeneration.height" :min="256" :max="2048" :step="64"
                    :disabled="!modifiable('height')"></slide-bar>
            </div>
            <div v-if="modifiableOrDisplayed('scheduler')" class="flex flex-col gap-2">
                <p>{{ languages.SETTINGS_MODEL_SCHEDULER }}</p>
                <drop-selector :array="globalSetup.models.scheduler" @change="imageGeneration.scheduler = $event"
                    :disabled="!modifiable('scheduler')">
                    <template #selected>
                        {{ imageGeneration.scheduler }}
                    </template>
                    <template #list="slotItem">
                        {{ slotItem.item }}
                    </template>
                </drop-selector>
            </div>
            <div v-if="modifiableOrDisplayed('guidanceScale')" class="flex flex-col gap-2">
                <p>{{ languages.SETTINGS_MODEL_IMAGE_CFG }}</p>
                <slide-bar v-model:current="imageGeneration.guidanceScale" :min="0" :max="10" :step="1"
                    :disabled="!modifiable('guidanceScale')"></slide-bar>
            </div>
            <div class="flex flex-col gap-2">
                <p
                    v-if="modifiableOrDisplayed('imageModel') || modifiableOrDisplayed('inpaintModel') || modifiableOrDisplayed('lora')">
                    {{ languages.SETTINGS_MODEL_IMAGE_MODEL }}</p>
                <div v-if="modifiableOrDisplayed('imageModel')" class="flex items-center gap-2">
                    <drop-selector :array="globalSetup.models.stableDiffusion"
                        @change="imageGeneration.imageModel = $event" :disabled="!modifiable('imageModel')">
                        <template #selected>
                            <div class="flex gap-2 items-center">
                                <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                <span>{{ imageGeneration.imageModel }}</span>
                            </div>
                        </template>
                        <template #list="slotItem">
                            <div class="flex gap-2 items-center">
                                <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                <span>{{ slotItem.item }}</span>
                            </div>
                        </template>
                    </drop-selector>
                    <button class="svg-icon i-refresh w-5 h-5 text-purple-500"
                        @click="globalSetup.refreshSDModles"></button>
                </div>
            </div>
            <div v-if="modifiableOrDisplayed('inpaintModel')" class="flex flex-col gap-2">
                <p>{{ languages.SETTINGS_MODEL_INPAINT_MODEL }}</p>
                <div class="flex items-center gap-2">
                    <drop-selector :array="globalSetup.models.inpaint" 
                        @change="imageGeneration.inpaintModel = $event" :disabled="!modifiable('inpaintModel')">
                        <template #selected>
                            <div class="flex gap-2 items-center">
                                <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                <span>{{ imageGeneration.inpaintModel }}</span>
                            </div>
                        </template>
                        <template #list="slotItem">
                            <div class="flex gap-2 items-center">
                                <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                <span>{{ slotItem.item }}</span>
                            </div>
                        </template>
                    </drop-selector>
                    <button class="svg-icon i-refresh w-5 h-5 text-purple-500"
                        @click="globalSetup.refreshInpaintModles"></button>
                </div>
            </div>
            <div v-if="modifiableOrDisplayed('lora')" class="flex flex-col gap-2">
                <p>{{ languages.SETTINGS_MODEL_LORA }}</p>
                <div class="flex items-center gap-2">
                    <drop-selector :array="globalSetup.models.lora" @change="imageGeneration.lora = $event"
                        :disabled="!modifiable('lora')">
                        <template #selected>
                            {{ imageGeneration.lora }}
                        </template>
                    </drop-selector>
                    <button class="svg-icon i-refresh w-5 h-5 text-purple-500"
                        @click="globalSetup.refreshLora"></button>
                </div>
            </div>
        </div>
        <button class="mt-4" @click="imageGeneration.resetActiveWorkflowSettings"><div class="svg-icon i-refresh">Reset</div>Load workflow defaults</button>
    </div>
</template>
<script setup lang="ts">
import { Setting, useImageGeneration } from "@/assets/js/store/imageGeneration";
import WorkflowSelector from "../components/SettingsImageWorkflowSelector.vue";
import SlideBar from "../components/SlideBar.vue";
import ResolutionPicker from "../components/ui/slider/ResolutionPicker.vue";
import RandomNumber from "../components/RandomNumber.vue";
import DropSelector from "../components/DropSelector.vue";
import { useI18N } from '@/assets/js/store/i18n';
import { useGlobalSetup } from "@/assets/js/store/globalSetup";

const imageGeneration = useImageGeneration();
const globalSetup = useGlobalSetup();

const anyModifiableOrDisplayed = (settings: Setting[]) => settings.some(setting => modifiableOrDisplayed(setting))
const modifiableOrDisplayed = (setting: Setting) => imageGeneration.activeWorkflow.modifiableSettings.includes(setting) || imageGeneration.activeWorkflow.displayedSettings.includes(setting)
const modifiable = (setting: Setting) => imageGeneration.activeWorkflow.modifiableSettings.includes(setting)

const i18n = useI18N();

</script>