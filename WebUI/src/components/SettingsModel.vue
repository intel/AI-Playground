<template>
  <div class="border-b border-color-spilter flex flex-col gap-5 py-4">
    <h2 class="text-center font-bold">{{ languages.SETTINGS_MODEL_HUGGINGFACE }}</h2>
    <div class="flex flex-col gap-3">
      <p>{{ languages.SETTINGS_MODEL_HUGGINGFACE_API_TOKEN }}</p>
      <div class="flex flex-col items-start gap-1">
        <Input type="password" v-model="models.hfToken"
               :class="{ 'border-red-500': models.hfToken && !models.hfTokenIsValid }"/>
        <div class="text-xs text-red-500 select-none"
             :class="{'opacity-0': !(models.hfToken && !models.hfTokenIsValid)}">
          {{ languages.SETTINGS_MODEL_HUGGINGFACE_INVALID_TOKEN_TEXT }}
        </div>
      </div>
    </div>
  </div>
  <div class="border-b border-color-spilter flex flex-col gap-5 py-4">
    <h2 class="text-center font-bold">{{ languages.SETTINGS_MODEL_BACKEND }}</h2>
    <div class="flex flex-col gap-3">
      <p>{{ languages.BACKEND_REQUIRED_COMPONENTS }}</p>
      <table class="text-center w-full" style="table-layout: fixed;">
        <tbody>
        <tr v-for="item in apiServiceInformation.filter((i) => i.isRequired)">
          <td style="text-align: left">{{ item.serviceName }}</td>
          <td :style="{ color: mapColorToStatus(item.status['status']) }">{{ item.status["status"] }}</td>
        </tr>
        </tbody>
      </table>
      <p>{{ languages.BACKEND_OPTIONAL_COMPONENTS }}</p>
      <table class="text-center w-full" style="table-layout: fixed;">
        <tbody>
        <tr v-for="item in apiServiceInformation.filter((i) => !i.isRequired)">
          <td style="text-align: left">{{ item.serviceName }}</td>
          <td :style="{ color: mapColorToStatus(item.status['status']) }">{{ item.status["status"] }}</td>
        </tr>
        </tbody>
      </table>
      <div class="flex flex-col pt-5">
        <button @click="globalSetup.loadingState = 'manageInstallations'"
                class="confirm-btn">{{ languages.SETTINGS_MODEL_MANAGE_BACKEND }}
        </button>
      </div>
    </div>
  </div>
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
        }}
      </button>
      <button class="confirm-btn" @click="applyPresetModelSettings" :disabled="!presetModelChange">{{
          languages.COM_APPLY
        }}
      </button>
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
        }}
      </button>
      <button class="confirm-btn" @click="applyPathsSettings" :disabled="!pathsChange">{{
          languages.COM_APPLY
        }}
      </button>
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
                          <span class="text-gray-300 flex-auto">{{
                              languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STRANDARD
                            }}:
                              dreamshaper-8</span>
        <span class="flex-none text-right">6.46 GB</span>
        <button class="text-yellow-500 flex-none"
                @click="downloadModel('Lykon/dreamshaper-8', Const.MODEL_TYPE_STABLE_DIFFUSION)">{{
            languages.COM_DOWNLOAD
          }}
        </button>
      </div>
      <div class="flex justify-between items-center gap-6">
                          <span class="text-gray-300 flex-auto">{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_HD }}:
                              Juggernaut-XL-v9</span>
        <span class="flex-none text-right">7.65 GB</span>
        <button class="text-yellow-500 flex-none"
                @click="downloadModel('RunDiffusion/Juggernaut-XL-v9', Const.MODEL_TYPE_STABLE_DIFFUSION)">{{
            languages.COM_DOWNLOAD
          }}
        </button>
      </div>
    </div>
    <div class="flex flex-col gap-3">
      <p>{{ languages.DOWNLOADER_FOR_INAPINT_GENERATE }}</p>
      <div class="flex justify-between items-center gap-6">
                          <span class="text-gray-300 flex-auto">{{
                              languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STRANDARD
                            }}:
                              dreamshaper-8-inpainting</span>
        <span class="flex-none text-right">4.45 GB</span>
        <button class="text-yellow-500 flex-none"
                @click="downloadModel('Lykon/dreamshaper-8-inpainting', Const.MODEL_TYPE_INPAINT)">{{
            languages.COM_DOWNLOAD
          }}
        </button>
      </div>
    </div>
    <div class="flex flex-col gap-3">
      <p>{{ languages.DOWNLOADER_FOR_IMAGE_LORA }}</p>
      <div class="flex items-center gap-4">
                          <span class="text-gray-300 flex-auto">{{
                              languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STRANDARD
                            }}:
                              lcm-lora-sdv1-5</span>
        <span class="flex-none text-right">128 MB</span>
        <button class="text-yellow-500 flex-none"
                @click="downloadModel('latent-consistency/lcm-lora-sdv1-5', Const.MODEL_TYPE_LORA)">{{
            languages.COM_DOWNLOAD
          }}
        </button>
      </div>
      <div class="flex items-center gap-4">
                          <span class="text-gray-300 flex-auto">{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_HD }}:
                              lcm-lora-sdxl</span>
        <span class="flex-none text-right">375.61 MB</span>
        <button class="text-yellow-500 flex-none"
                @click="downloadModel('latent-consistency/lcm-lora-sdxl', Const.MODEL_TYPE_LORA)">{{
            languages.COM_DOWNLOAD
          }}
        </button>
      </div>
    </div>
    <div class="flex flex-col gap-3">
      <p>{{ languages.DOWNLOADER_FOR_ANSWER_GENERATE }}</p>
      <div class="flex items-center gap-4">
        <span class="text-gray-300 flex-auto">microsoft/Phi-3-mini-4k-instruct</span>
        <span class="flex-none text-right">7.11 GB</span>
        <button class="text-yellow-500 flex-none"
                @click="downloadModel('microsoft/Phi-3-mini-4k-instruct', Const.MODEL_TYPE_LLM)">{{
            languages.COM_DOWNLOAD
          }}
        </button>
      </div>
    </div>
    <div class="flex flex-col gap-3">
      <p>{{ languages.DOWNLOADER_FOR_RAG_QUERY }}</p>
      <div class="flex items-center gap-4">
                          <span class="text-gray-300 flex-auto">{{
                              languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STRANDARD
                            }}:
                              bge-large-en-v1.5</span>
        <span class="flex-none text-right">1.25 GB</span>
        <button class="text-yellow-500 flex-none"
                @click="downloadModel('BAAI/bge-large-en-v1.5', Const.MODEL_TYPE_EMBEDDING)">{{
            languages.COM_DOWNLOAD
          }}
        </button>
      </div>
      <div class="flex items-center gap-4">
                          <span class="text-gray-300 flex-auto">{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION_HD }}:
                              bge-large-zh-v1.5</span>
        <span class="flex-none text-right">1.21 GB</span>
        <button class="text-yellow-500 flex-none"
                @click="downloadModel('BAAI/bge-large-zh-v1.5', Const.MODEL_TYPE_EMBEDDING)">{{
            languages.COM_DOWNLOAD
          }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {useI18N} from "@/assets/js/store/i18n";
import {useModels} from "@/assets/js/store/models";
import DropSelector from "../components/DropSelector.vue";
import FolderSelector from "../components/FolderSelector.vue";
import {Input} from '@/components/ui/input'
import {toast} from "@/assets/js/toast";
import {Const} from "@/assets/js/const";
import {useGlobalSetup} from "@/assets/js/store/globalSetup.ts";
import {mapColorToStatus} from "@/lib/utils.ts";


const i18n = useI18N();
const models = useModels();
const globalSetup = useGlobalSetup();

const presetModel = reactive<StringKV>(Object.assign({}, toRaw(globalSetup.presetModel)));
const presetModelChange = ref(false);

const paths = reactive<ModelPaths>(Object.assign({}, toRaw(globalSetup.paths)));
const pathsChange = ref(false);

const apiServiceInformation = ref<ApiServiceInformation[]>([])

const emits = defineEmits<{
  (e: "showDownloadModelConfirm", downloadList: DownloadModelParam[], success?: () => void, fail?: () => void): void
}>();

onMounted(() => {
  cancelPathsSettings();
})

//TODO: Change to continuous update
onBeforeMount(async () => {
  apiServiceInformation.value = await window.electronAPI.getServiceRegistry()
})

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
  presetModelChange.value = false;
}

function restorePresetModelSettings() {
  presetModel.SDStandard = "Lykon/dreamshaper-8";
  presetModel.SDStandardInpaint = "Lykon/dreamshaper-8-inpainting";
  presetModel.SDHD = "RunDiffusion/Juggernaut-XL-v9";
  presetModel.SDHDInpaint = useI18N().state.ENHANCE_INPAINT_USE_IMAGE_MODEL;

  applyPresetModelSettings();
}

function downloadModel(model_repo_id: string, type: number) {
  const params: CheckModelAlreadyLoadedParameters[] = [{repo_id: model_repo_id, type: type, backend: "default"}];
  globalSetup.checkModelAlreadyLoaded(params)
      .then(exits => {
        if (exits[0].already_loaded) {
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

function cancelPathsSettings() {
  Object.keys(paths).forEach((key) => {
    paths[key] = globalSetup.paths[key];
  });
  pathsChange.value = false;
}

</script>