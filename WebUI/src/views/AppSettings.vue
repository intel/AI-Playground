<template>
    <div id="app-settings-panel"
        class="settings-panel absolute right-0 top-0 h-full bg-color-bg-main text-sm text-white py-4">
        <div class="flex justify-between items-center px-3">
            <div class="flex items-center gap-2">
                <button class="panel-tab" :class="{ 'active': tabIndex == 0 }" @click="tabIndex = 0">
                    {{ languages.SETTINGS_TAB_BASIC }}
                </button>
                <button class="panel-tab" :class="{ 'active': tabIndex == 1 }" @click="tabIndex = 1">
                    {{ languages.SETTINGS_TAB_MODEL }}
                </button>
            </div>
            <button class="w-6 h-6" @click="emits('close')">
                <span class="svg-icon i-right-arrow h-4 w-4"></span>
            </button>
        </div>
        <!--BasicSettingsTab-->
        <div v-show="tabIndex == 0" class="flex-auto h-0 flex flex-col gap-5 pt-3 border-t border-color-spilter">
            <div class="px-3 flex-none flex flex-col gap-3">
                <div class="flex flex-col gap-2">
                    <p>{{ languages.SETTINGS_BASIC_LANGUAGE }}</p>
                    <div class="grid grid-cols-2 gap-2">
                        <radio-bolck :checked="i18n.langName == 'en_US'" :text="languages.SETTINGS_BASIC_LANGUAGE_EN"
                            @click="() => { i18n.switchLanguage('en_US') }"></radio-bolck>
                        <radio-bolck :checked="i18n.langName == 'zh_CN'" :text="languages.SETTINGS_BASIC_LANGUAGE_ZH"
                            @click="() => { i18n.switchLanguage('zh_CN') }"></radio-bolck>
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
                <div class="flex flex-col gap-2">
                    <p>{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION }}</p>
                    <div class="grid grid-cols-3 items-center gap-2 flex-wrap">
                        <radio-bolck :checked="modelSettings.resolution == 0"
                            :text="languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STRANDARD"
                            @click="() => { changeResolution(0) }"></radio-bolck>
                        <radio-bolck :checked="modelSettings.resolution == 1"
                            :text="languages.SETTINGS_MODEL_IMAGE_RESOLUTION_HD"
                            @click="() => { changeResolution(1) }"></radio-bolck>
                        <radio-bolck :checked="modelSettings.resolution == 3"
                            :text="languages.SETTINGS_MODEL_QUALITY_MANUAL"
                            @click="() => { changeResolution(3) }"></radio-bolck>
                    </div>
                </div>
                <div class="flex flex-col gap-2">
                    <p>{{ languages.SETTINGS_MODEL_QUALITY }}</p>
                    <div class="grid grid-cols-3 items-center gap-2 flex-wrap">
                        <radio-bolck :checked="modelSettings.quality == 0"
                            :text="languages.SETTINGS_MODEL_QUALITY_STANDARD" @click="() => { changeQuality(0) }"
                            :disabled="qualityDisable"></radio-bolck>
                        <radio-bolck :checked="modelSettings.quality == 1" :text="languages.SETTINGS_MODEL_QUALITY_HIGH"
                            @click="() => { changeQuality(1) }" :disabled="qualityDisable"></radio-bolck>
                        <radio-bolck :checked="modelSettings.quality == 2" :text="languages.SETTINGS_MODEL_QUALITY_FAST"
                            @click="() => { changeQuality(2) }" :disabled="qualityDisable"></radio-bolck>
                    </div>
                </div>
                <div class="flex items-center gap-5">
                    <p>{{ languages.SETTINGS_MODEL_IMAGE_PREVIEW }}</p>
                    <button v-show=true class="v-checkbox-control flex-none w-5 h-5"
                        :class="{ 'v-checkbox-checked': globalSetup.modelSettings.imagePreview }"
                        @click="() => toggleImagePreview(!globalSetup.modelSettings.imagePreview)">
                    </button>
                </div>
            </div>
            <div class="overflow-y-auto">
                <div class="border-t border-color-spilter flex-auto justify-center pt-3 grid grid-cols-1 gap-5 mx-3">
                    <h2 class="text-center font-bold">{{ languages.SETTINGS_MODEL_ADJUSTABLE_OPTIONS }}</h2>
                    <!-- 
                    <div class="flex flex-col gap-2">
                        <p>Fast Resolution</p>
                        <drop-selector :array="sizePreset" @change="changeSize">
                            <template #selected>
                                <span>{{ sizeChoose }}</span>
                            </template>
<template #list="slotItem">
                                <span>{{ `${slotItem.item.width} x ${slotItem.item.height}` }}</span>
                            </template>
</drop-selector>
</div>
-->
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_IMAGE_WIDTH }}</p>
                        <slide-bar v-model:current="modelSettings.width" :min="widthRange.min" :max="widthRange.max"
                            :step="8" @update:current="applyModelSettings"></slide-bar>
                    </div>
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_IMAGE_HEIGHT }}</p>
                        <slide-bar v-model:current="modelSettings.height" :min="heightRange.min" :max="heightRange.max"
                            :step="8" @update:current="applyModelSettings"></slide-bar>
                    </div>
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_IMAGE_STEPS }}</p>
                        <slide-bar v-model:current="modelSettings.inferenceSteps" :min="1" :max="50" :step="1"
                            :disabled="modelSettings.resolution != 3" @update:current="applyModelSettings"></slide-bar>
                    </div>
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_SEED }}</p>

                        <random-number v-model:value="modelSettings.seed" :default="-1" :min="0" :max="4294967295"
                            :scale="1" @update:value="applyModelSettings"></random-number>
                    </div>
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_GENERATE_NUMBER }}</p>
                        <slide-bar v-model:current="modelSettings.generateNumber" :min="1" :max="4" :step="1"
                            @update:current="applyModelSettings"></slide-bar>
                    </div>
                    <div class="flex items-center gap-5">
                        <p>{{ languages.SETTINGS_MODEL_SAFE_CHECK }}</p>
                        <button v-show=true class="v-checkbox-control flex-none w-5 h-5"
                            :class="{ 'v-checkbox-checked': globalSetup.modelSettings.safeCheck }"
                            @click="() => toggleSafeCheck(!globalSetup.modelSettings.safeCheck)">
                        </button>
                    </div>
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_NEGATIVE_PROMPT }}</p>
                        <textarea class="h-32 rounded-lg resize-none" v-model="modelSettings.negativePrompt"
                            @change="applyModelSettings"></textarea>
                    </div>
                    <h2 class="text-center font-bold">{{ languages.SETTINGS_MODEL_MANUAL_OPTIONS }}</h2>
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_IMAGE_MODEL }}</p>
                        <div class="flex items-center gap-2">
                            <drop-selector :array="globalSetup.models.stableDiffusion" @change="changeSDModel"
                                :disabled="modelSettings.resolution != 3">
                                <template #selected>
                                    <div class="flex gap-2 items-center">
                                        <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                        <span>{{ modelSettings.sd_model }}</span>
                                    </div>
                                </template>
                                <template #list="slotItem">
                                    <div class="flex gap-2 items-center">
                                        <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                        <span>{{ slotItem.item }}</span>
                                    </div>
                                </template>
                            </drop-selector>
                            <button class="svg-icon i-refresh w-5 h-5 text-purple-500" @animationend="removeRonate360"
                                @click="refreshSDModles"></button>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_INPAINT_MODEL }}</p>
                        <div class="flex items-center gap-2">
                            <drop-selector :array="globalSetup.models.inpaint" @change="changeInpaintModel"
                                :disabled="modelSettings.resolution != 3">
                                <template #selected>
                                    <div class="flex gap-2 items-center">
                                        <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                        <span>{{ globalSetup.modelSettings.inpaint_model }}</span>
                                    </div>
                                </template>
                                <template #list="slotItem">
                                    <div class="flex gap-2 items-center">
                                        <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                        <span>{{ slotItem.item }}</span>
                                    </div>
                                </template>
                            </drop-selector>
                            <button class="svg-icon i-refresh w-5 h-5 text-purple-500" @animationend="removeRonate360"
                                @click="refreshInpaintModles"></button>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_SCHEDULER }}</p>
                        <drop-selector :array="globalSetup.models.scheduler" @change="changeScheduler"
                            :disabled="modelSettings.resolution != 3">
                            <template #selected>
                                {{ modelSettings.scheduler == "None" ? languages.COM_DEFAULT : modelSettings.scheduler
                                }}
                            </template>
                            <template #list="slotItem">
                                {{ slotItem.item == "None" ? languages.COM_DEFAULT : slotItem.item }}
                            </template>
                        </drop-selector>
                    </div>
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_LORA }}</p>
                        <div class="flex items-center gap-2">
                            <drop-selector :array="globalSetup.models.lora" @change="changeLora"
                                :disabled="modelSettings.resolution != 3">
                                <template #selected>
                                    {{ modelSettings.lora }}
                                </template>
                            </drop-selector>
                            <button class="svg-icon i-refresh w-5 h-5 text-purple-500" @animationend="removeRonate360"
                                @click="refreshLora"></button>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2">
                        <p>{{ languages.SETTINGS_MODEL_IMAGE_CFG }}</p>
                        <slide-bar v-model:current="modelSettings.guidanceScale" :min="0" :max="10" :step="1"
                            :disabled="modelSettings.resolution != 3" @update:current="applyModelSettings"></slide-bar>
                    </div>
                </div>
            </div>
        </div>
        <!--Model-->
        <div v-show="tabIndex == 1" class="px-3 flex flex-col overflow-y-auto">
            <div class="border-b border-color-spilter flex flex-col gap-5 py-4">
                <h2 class="text-center font-bold">{{ languages.SETTINGS_MODEL_SD_PRESET_MODEL }}</h2>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.SETTINGS_MODEL_SD_STANDARD_MODEL }}</p>
                    <div class="flex items-center gap-2">
                        <drop-selector :array="globalSetup.models.stableDiffusion"
                            @change="(value, _) => { customPresetModel('SDStandard', value) }">
                            <template #selected>
                                <div class="flex gap-2 items-center">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span>{{ presetModel.SDStandard }}</span>
                                </div>
                            </template>
                            <template #list="slotItem">
                                <div class="flex gap-2 items-center">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span>{{ slotItem.item }}</span>
                                </div>
                            </template>
                        </drop-selector>
                        <button class="svg-icon i-refresh w-5 h-5 text-purple-500" @animationend="removeRonate360"
                            @click="refreshSDModles"></button>
                    </div>
                </div>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.SETTINGS_MODEL_SD_STANDARD_INPAINT_MODEL }}</p>
                    <div class="flex items-center gap-2">
                        <drop-selector :array="globalSetup.models.inpaint"
                            @change="(value, _) => { customPresetModel('SDStandardInpaint', value) }">
                            <template #selected>
                                <div class="flex gap-2 items-center">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span>{{ presetModel.SDStandardInpaint }}</span>
                                </div>
                            </template>
                            <template #list="slotItem">
                                <div class="flex gap-2 items-center">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span>{{ slotItem.item }}</span>
                                </div>
                            </template>
                        </drop-selector>
                        <button class="svg-icon i-refresh w-5 h-5 text-purple-500" @animationend="removeRonate360"
                            @click="refreshInpaintModles"></button>
                    </div>
                </div>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.SETTINGS_MODEL_SD_HD_MODEL }}</p>
                    <div class="flex items-center gap-2">
                        <drop-selector :array="globalSetup.models.stableDiffusion"
                            @change="(value, _) => { customPresetModel('SDHD', value) }">
                            <template #selected>
                                <div class="flex gap-2 items-center">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span>{{ presetModel.SDHD }}</span>
                                </div>
                            </template>
                            <template #list="slotItem">
                                <div class="flex gap-2 items-center">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span>{{ slotItem.item }}</span>
                                </div>
                            </template>
                        </drop-selector>
                        <button class="svg-icon i-refresh w-5 h-5 text-purple-500" @animationend="removeRonate360"
                            @click="refreshSDModles"></button>
                    </div>
                </div>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.SETTINGS_MODEL_SD_HD_INPAINT_MODEL }}</p>
                    <div class="flex items-center gap-2">
                        <drop-selector :array="globalSetup.models.inpaint"
                            @change="(value, _) => { customPresetModel('SDHDInpaint', value) }">
                            <template #selected>
                                <div class="flex gap-2 items-center">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span>{{ presetModel.SDHDInpaint }}</span>
                                </div>
                            </template>
                            <template #list="slotItem">
                                <div class="flex gap-2 items-center">
                                    <span class="rounded-full bg-green-500 w-2 h-2"></span>
                                    <span>{{ slotItem.item }}</span>
                                </div>
                            </template>
                        </drop-selector>
                        <button class="svg-icon i-refresh w-5 h-5 text-purple-500" @animationend="removeRonate360"
                            @click="refreshInpaintModles"></button>
                    </div>
                </div>
                <div class="flex items-center justify-end gap-3">
                    <a href="javascript:" class="text-yellow-500" @click="restorePresetModelSettings">{{
                        languages.COM_RESTORE
                        }}</a>
                    <button class="cancel-btn" @click="cancelPresetModelChange" :disabled="!presetModelChange">{{
                        languages.COM_CANCEL
                        }}</button>
                    <button class="confirm-btn" @click="applyPresetModelSettings" :disabled="!presetModelChange">{{
                        languages.COM_APPLY
                        }}</button>
                </div>
            </div>
            <div class="border-b border-color-spilter flex flex-col gap-5 py-4">
                <h2 class="text-center font-bold">{{ languages.SETTINGS_BASIC_PATHS }}</h2>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.SETTINGS_BASIC_LLM_CHECKPOINTS }}</p>
                    <folder-selector v-model:folder="paths.llm"
                        @update:folder="(value) => customPathsSettings('llm', value)"></folder-selector>
                </div>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.SETTINGS_MODEL_SD_CHECKPOINTS }}</p>
                    <folder-selector v-model:folder="paths.stableDiffusion"
                        @update:folder="(value) => customPathsSettings('stableDiffusion', value)"></folder-selector>
                </div>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.SETTINGS_MODEL_SD_INPAINT_CHECKPOINTS }}</p>
                    <folder-selector v-model:folder="paths.stableDiffusion"
                        @update:folder="(value) => customPathsSettings('inpaint', value)"></folder-selector>
                </div>
                <!-- <div class="flex flex-col gap-3">
                    <p>{{ languages.SETTINGS_MODEL_SD_VAE }}</p>
                    <folder-selector v-model:folder="paths.vae"
                        @update:folder="(value) => customPathsSettings('vae', value)"></folder-selector>
                </div> -->
                <div class="flex flex-col gap-3">
                    <p>{{ languages.SETTINGS_MODEL_SD_LORA }}</p>
                    <folder-selector v-model:folder="paths.lora"
                        @update:folder="(value) => customPathsSettings('lora', value)"></folder-selector>
                </div>
                <div class="flex items-center justify-end gap-3">
                    <a href="javascript:" class="text-yellow-500" @click="restorePathsSettings">{{
                        languages.COM_RESTORE
                        }}</a>
                    <button class="cancel-btn" @click="cancelPathsSettings" :disabled="!pathsChange">{{
                        languages.COM_CANCEL
                        }}</button>
                    <button class="confirm-btn" @click="applyPathsSettings" :disabled="!pathsChange">{{
                        languages.COM_APPLY
                        }}</button>
                </div>
            </div>
            <div class="flex flex-col gap-5 py-4">
                <div>
                    <h2 class="text-center font-bold mb-1">{{ languages.SETTINGS_MODEL_DOWNLOAD }}</h2>
                    <p class="text-xs text-justify  text-gray-300">{{ languages.SETTINGS_MODEL_DOWNLOAD_DESC }}</p>
                </div>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.DOWNLOADER_FOR_IMAGE_GENERATE }}
                    </p>

                    <div class="flex justify-between items-center gap-6">
                        <span class="text-gray-300 flex-auto">{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STRANDARD }}:
                            dreamshaper-8</span>
                        <span class="flex-none text-right">6.46 GB</span>
                        <button class="text-yellow-500 flex-none"
                            @click="downloadModel('Lykon/dreamshaper-8', Const.MODEL_TYPE_STABLE_DIFFUSION)">{{
                                languages.COM_DOWNLOAD }}</button>
                    </div>
                    <div class="flex justify-between items-center gap-6">
                        <span class="text-gray-300 flex-auto">{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_HD }}:
                            Juggernaut-XL-v9</span>
                        <span class="flex-none text-right">7.65 GB</span>
                        <button class="text-yellow-500 flex-none"
                            @click="downloadModel('RunDiffusion/Juggernaut-XL-v9', Const.MODEL_TYPE_STABLE_DIFFUSION)">{{
                                languages.COM_DOWNLOAD }}</button>
                    </div>
                </div>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.DOWNLOADER_FOR_INAPINT_GENERATE }}</p>
                    <div class="flex justify-between items-center gap-6">
                        <span class="text-gray-300 flex-auto">{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STRANDARD }}:
                            dreamshaper-8-inpainting</span>
                        <span class="flex-none text-right">4.45 GB</span>
                        <button class="text-yellow-500 flex-none"
                            @click="downloadModel('Lykon/dreamshaper-8-inpainting', Const.MODEL_TYPE_INPAINT)">{{
                                languages.COM_DOWNLOAD }}</button>
                    </div>
                </div>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.DOWNLOADER_FOR_IMAGE_LORA }}</p>
                    <div class="flex items-center gap-4">
                        <span class="text-gray-300 flex-auto">{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STRANDARD }}:
                            lcm-lora-sdv1-5</span>
                        <span class="flex-none text-right">128 MB</span>
                        <button class="text-yellow-500 flex-none"
                            @click="downloadModel('latent-consistency/lcm-lora-sdv1-5', Const.MODEL_TYPE_LORA)">{{
                                languages.COM_DOWNLOAD }}</button>
                    </div>
                    <div class="flex items-center gap-4">
                        <span class="text-gray-300 flex-auto">{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_HD }}:
                            lcm-lora-sdxl</span>
                        <span class="flex-none text-right">375.61 MB</span>
                        <button class="text-yellow-500 flex-none"
                            @click="downloadModel('latent-consistency/lcm-lora-sdxl', Const.MODEL_TYPE_LORA)">{{
                                languages.COM_DOWNLOAD }}</button>
                    </div>
                </div>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.DOWNLOADER_FOR_ANSWER_GENERATE }}</p>
                    <div class="flex items-center gap-4">
                        <span class="text-gray-300 flex-auto">microsoft/Phi-3-mini-4k-instruct</span>
                        <span class="flex-none text-right">7.11 GB</span>
                        <button class="text-yellow-500 flex-none"
                            @click="downloadModel('microsoft/Phi-3-mini-4k-instruct', Const.MODEL_TYPE_LLM)">{{
                                languages.COM_DOWNLOAD }}</button>
                    </div>
                </div>
                <div class="flex flex-col gap-3">
                    <p>{{ languages.DOWNLOADER_FOR_RAG_QUERY }}</p>
                    <div class="flex items-center gap-4">
                        <span class="text-gray-300 flex-auto">{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STRANDARD }}:
                            bge-large-en-v1.5</span>
                        <span class="flex-none text-right">1.25 GB</span>
                        <button class="text-yellow-500 flex-none"
                            @click="downloadModel('BAAI/bge-large-en-v1.5', Const.MODEL_TYPE_EMBEDDING)">{{
                                languages.COM_DOWNLOAD }}</button>
                    </div>
                    <div class="flex items-center gap-4">
                        <span class="text-gray-300 flex-auto">{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_HD }}:
                            bge-large-zh-v1.5</span>
                        <span class="flex-none text-right">1.21 GB</span>
                        <button class="text-yellow-500 flex-none"
                            @click="downloadModel('BAAI/bge-large-zh-v1.5', Const.MODEL_TYPE_EMBEDDING)">{{
                                languages.COM_DOWNLOAD }}</button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
<script setup lang="ts">
import DropSelector from "../components/DropSelector.vue";
import SlideBar from "../components/SlideBar.vue";
import RadioBolck from "../components/RadioBlock.vue";
import RandomNumber from "../components/RandomNumber.vue";
import FolderSelector from "../components/FolderSelector.vue";
import { useGlobalSetup } from "@/assets/js/store/globalSetup";
import { useI18N } from "@/assets/js/store/i18n";
import { toast } from "@/assets/js/toast";
import { Const } from "@/assets/js/const";

const i18n = useI18N();
const globalSetup = useGlobalSetup();
const tabIndex = ref(0);
const modelSettings = reactive<KVObject>(Object.assign({}, toRaw(globalSetup.modelSettings)));
const paths = reactive<ModelPaths>(Object.assign({}, toRaw(globalSetup.paths)));
const presetModel = reactive<StringKV>(Object.assign({}, toRaw(globalSetup.presetModel)));
console.log(toRaw(globalSetup.presetModel))
const presetModelChange = ref(false);
const modelSettingsChange = ref(false);
const pathsChange = ref(false);
const widthRange = ref<NumberRange>({
    min: 256,
    max: 768,
});

const heightRange = ref<NumberRange>({
    min: 256,
    max: 768,
});
const qualityDisable = computed(() => modelSettings.resolution == 3);
const sizePreset = ref<Size[]>([]);
const sizeChoose = computed(() => {
    for (const item of sizePreset.value) {
        if (modelSettings.width == item.width && modelSettings.height == item.height) {
            return `${item.width} x ${item.height}`
        }
    }
    return "custom";
});

const graphicsName = computed(() => {
    return globalSetup.graphicsList.find(item => modelSettings.graphics as number == item.index)?.name || "";
})

const sizeLimit = reactive<{ [key: string]: ResolutionSettings }>({
    standard: {
        width: { min: 256, max: 768 },
        height: { min: 256, max: 768 },
        preset: [{ width: 256, height: 256 }, { width: 512, height: 512 }, { width: 768, height: 768 }]
    },
    hd: {
        width: { min: 768, max: 1536 },
        height: { min: 768, max: 1536 },
        preset: [{ width: 768, height: 768 }, { width: 1024, height: 1024 }, { width: 1536, height: 1536 }]
    },
    manual: {
        width: { min: 256, max: 1536 },
        height: { min: 256, max: 1536 },
        preset: [{ width: 256, height: 256 }, { width: 512, height: 512 }, { width: 768, height: 768 }, { width: 1024, height: 1024 }, { width: 1536, height: 1536 }]
    }
});


const emits = defineEmits<{
    (e: "showDownloadModelConfirm", downloadList: DownloadModelParam[], success?: () => void, fail?: () => void): void,
    (e: "close"): void
}>();

const modelSettingsWatcher = watchEffect(() => {
    modelSettings.llm = globalSetup.modelSettings.llm;
    modelSettings.sd_model = globalSetup.modelSettings.sd_model;
    modelSettings.lora = globalSetup.modelSettings.lora;
});


onMounted(() => {
    cancelModelSettingsChange();
    cancelPathsSettings();
    updateSizeLimit();
})

onUnmounted(() => {
    modelSettingsWatcher();
})

function updateSizeLimit() {
    const settings = modelSettings.resolution == 0 ?
        sizeLimit.standard :
        modelSettings.resolution == 1 ?
            sizeLimit.hd :
            sizeLimit.manual;
    widthRange.value = settings.width;
    heightRange.value = settings.height;
    sizePreset.value = settings.preset;
    if (modelSettings.width > settings.width.max) {
        modelSettings.width = settings.width.max;
    }
    else if (modelSettings.width < settings.width.min) {
        modelSettings.width = settings.width.min;
    }
    if (modelSettings.height > settings.height.max) {
        modelSettings.height = settings.height.max;
    }
    else if (modelSettings.height < settings.height.min) {
        modelSettings.height = settings.height.min;
    }
}


function changeSDModel(item: any, _: number) {
    modelSettings.sd_model = item as string;
    applyModelSettings();
}

function changeLora(item: any, _: number) {
    modelSettings.lora = item as string;
    applyModelSettings();
}

function changeScheduler(item: any, _: number) {
    modelSettings.scheduler = item as string;
    applyModelSettings();
}

async function toggleImagePreview(value: boolean) {
    if (value) {
        modelSettings.imagePreview = 1
        applyModelSettings();
    }
    else {
        modelSettings.imagePreview = 0
        applyModelSettings();
    };
}

async function toggleSafeCheck(value: boolean) {
    if (value) {
        modelSettings.safeCheck = 1
        applyModelSettings();
    }
    else {
        modelSettings.safeCheck = 0
        applyModelSettings();
    };
}

async function customPathsSettings(key: string, path: string) {
    if (!await window.electronAPI.existsPath(path)) {
        toast.error(i18n.state.ERROR_FOLDER_NOT_EXISTS);
        paths[key] = globalSetup.paths[key];
        return;
    }
    pathsChange.value = true;
}

async function applyPathsSettings() {
    if (await globalSetup.applyPathsSettings(toRaw(paths))) {
        toast.warning(i18n.state.SETTINGS_MODEL_LIST_CHANGE_TIP);
    }
    pathsChange.value = false;
}

function cancelPathsSettings() {
    Object.keys(paths).forEach((key) => {
        paths[key] = globalSetup.paths[key];
    });
    pathsChange.value = false;
}

function cancelModelSettingsChange() {
    modelSettingsChange.value = false;
    Object.keys(modelSettings).forEach((key) => {
        modelSettings[key] = globalSetup.modelSettings[key];
    });
}

function applyModelSettings() {
    globalSetup.applyModelSettings(toRaw(modelSettings));
    modelSettingsChange.value = false;
}

function changeResolution(value: number) {
    modelSettings.resolution = value;
    setModelOptionByPreset();
}

function changeQuality(value: number) {
    modelSettings.quality = value;
    setModelOptionByPreset();
}

function setModelOptionByPreset() {
    const resolution = modelSettings.resolution;
    const quality = modelSettings.quality;
    if (resolution == 3) {
        const manualModelSettings = globalSetup.getManualModelSettings();
        Object.keys(toRaw(modelSettings)).forEach((key) => {
            if (key != "quality" && key in manualModelSettings) {
                modelSettings[key] = manualModelSettings[key];
            }
        });
        applyModelSettings();
    }
    else if (resolution == 0) {
        modelSettings.sd_model = globalSetup.presetModel.SDStandard;
        modelSettings.inpaint_model = globalSetup.presetModel.SDStandardInpaint;
        if (quality == 0) {
            modelSettings.width = 512;
            modelSettings.height = 512;
            modelSettings.guidanceScale = 7;
            modelSettings.inferenceSteps = 20;
            modelSettings.lora = "None";
            modelSettings.scheduler = "DPM++ SDE Karras";
            applyModelSettings();
        } else if (quality == 1) {
            modelSettings.guidanceScale = 7;
            modelSettings.inferenceSteps = 50;
            modelSettings.lora = "None";
            modelSettings.scheduler = "DPM++ SDE Karras";
            applyModelSettings();
        } else if (quality == 2) {
            modelSettings.guidanceScale = 1;
            modelSettings.inferenceSteps = 6;
            modelSettings.lora = "latent-consistency/lcm-lora-sdv1-5";
            modelSettings.scheduler = "LCM";
            applyModelSettings();
        }
    } else if (resolution == 1) {
        modelSettings.sd_model = globalSetup.presetModel.SDHD;
        modelSettings.inpaint_model = globalSetup.presetModel.SDHDInpaint;
        modelSettings.width = 1080;
        modelSettings.height = 1080;
        if (quality == 0) {
            modelSettings.guidanceScale = 7;
            modelSettings.inferenceSteps = 20;
            modelSettings.lora = "None";
            modelSettings.scheduler = "DPM++ SDE";
            applyModelSettings();
        } else if (quality == 1) {
            modelSettings.guidanceScale = 7;
            modelSettings.inferenceSteps = 50;
            modelSettings.lora = "None";
            modelSettings.scheduler = "DPM++ SDE";
            applyModelSettings();
        } else if (quality == 2) {
            modelSettings.guidanceScale = 1;
            modelSettings.inferenceSteps = 6;
            modelSettings.lora = "latent-consistency/lcm-lora-sdxl";
            modelSettings.scheduler = "LCM";
            applyModelSettings();
        }
    }
    updateSizeLimit();
}

function removeRonate360(ev: AnimationEvent) {
    const target = ev.target as HTMLElement;
    target.classList.remove("animate-ronate360");
}

async function refreshSDModles(e: Event) {
    const button = e.target as HTMLElement;
    button.classList.add("animate-ronate360");
    await globalSetup.refreshSDModles();
}

async function refreshInpaintModles(e: Event) {
    const button = e.target as HTMLElement;
    button.classList.add("animate-ronate360");
    await globalSetup.refreshInpaintModles();
}

async function refreshLora(e: Event) {
    const button = e.target as HTMLElement;
    button.classList.add("animate-ronate360");
    await globalSetup.refreshLora();
}

function customPresetModel(key: string, value: any) {
    presetModel[key] = value as string;
    presetModelChange.value = true;
}

function cancelPresetModelChange() {
    Object.keys(presetModel).forEach((key) => {
        presetModel[key] = globalSetup.presetModel[key];
    });
    presetModelChange.value = false;
}

function applyPresetModelSettings() {
    globalSetup.applyPresetModelSettings(toRaw(presetModel));
    if (globalSetup.modelSettings.resolution == 0) {
        globalSetup.modelSettings.sd_model = globalSetup.presetModel.SDStandard;
        toast.warning(i18n.state.SETTINGS_MODEL_LIST_CHANGE_TIP);
    } else if (globalSetup.modelSettings.resolution == 1) {
        globalSetup.modelSettings.sd_model = globalSetup.presetModel.SDHD;
        toast.warning(i18n.state.SETTINGS_MODEL_LIST_CHANGE_TIP);
    }
    setModelOptionByPreset();
    presetModelChange.value = false;
}

function restorePresetModelSettings() {
    presetModel.SDStandard = "Lykon/dreamshaper-8";
    presetModel.SDStandardInpaint = "Lykon/dreamshaper-8-inpainting";
    presetModel.SDHD = "RunDiffusion/Juggernaut-XL-v9";
    presetModel.SDHDInpaint = useI18N().state.ENHANCE_INPAINT_USE_IMAGE_MODEL;

    applyPresetModelSettings();
}

function changeSize(item: any, index: number) {
    const size = item as Size;
    modelSettings.width = size.width;
    modelSettings.height = size.height;
    applyModelSettings();
}

function changeInpaintModel(value: any, index: number) {
    globalSetup.applyModelSettings({ inpaint_model: value as string });
}

function changeGraphics(value: any, index: number) {
    globalSetup.applyModelSettings({ graphics: (value as GraphicsItem).index });
}

function downloadModel(model_repo_id: string, type: number) {
    const params = [{ repo_id: model_repo_id, type: type }];
    globalSetup.checkModelExists(params)
        .then(exits => {
            if (exits[0].exist) {
                toast.show(i18n.state.SETTINGS_MODEL_EXIST);
            } else {
                emits("showDownloadModelConfirm", params);
            }
        });
}

function restorePathsSettings() {
    globalSetup.restorePathsSettings();
    const newPaths = toRaw(globalSetup.paths);
    Object.keys(newPaths).forEach((key) => {
        paths[key] = newPaths[key]
    });
}
</script>