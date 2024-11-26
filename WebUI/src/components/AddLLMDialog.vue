<template>
    <div class="dialog-container z-10">
        <div class="dialog-mask absolute left-0 top-0 w-full h-full bg-black/55 flex justify-center items-center">
            <div class="py-10 px-20 w-500px flex flex-col items-center justify-center bg-gray-600 rounded-3xl gap-6 text-white"
                :class="{ 'animate-scale-in': animate }">
              <p v-html= "i18nState.REQUEST_LLM_MODEL_NAME"></p>
              <textarea class="rounded-xl border border-color-spilter flex-auto w-full h-auto resize-none" rows="1"
                        :placeholder="languages.COM_LLM_HF_PROMPT" v-model="modelRequest" @keydown="fastGenerate"></textarea>
              <p v-show = "addModelError" style="color: #F44336;">{{ addModelErrorMessage }}</p>
              <div class="flex justify-center items-center gap-9">
                <button @click="closeAdd" class="bg-color-control-bg  py-1 px-4 rounded">{{ i18nState.COM_CLOSE }}</button>
                <button @click="addModel" class="bg-color-control-bg  py-1 px-4 rounded">{{ i18nState.COM_ADD }}</button>
              </div>
            </div>
        </div>
    </div>
</template>
<script setup lang="ts">
import { useGlobalSetup } from '@/assets/js/store/globalSetup';
import { useI18N } from '@/assets/js/store/i18n';
import { useModels, userModels } from '@/assets/js/store/models';


const i18nState = useI18N().state;
const globalSetup = useGlobalSetup();
const models = useModels();
const modelRequest = ref("");
const addModelErrorMessage = ref("")
const addModelError = ref(false);
const animate = ref(false);
const emits = defineEmits<{
    (e: "close"): void,
    (e: "callCheckModel"): void,
    (e: "showWarning", warning : string, func : () => void): void
}>();


function fastGenerate(e: KeyboardEvent) {
  if (e.code == "Enter") {
    if (e.ctrlKey || e.shiftKey || e.altKey) {
      modelRequest.value += "\n";
    } else {
      e.preventDefault();
      if (modelRequest.value !== "") {
        addModel()
      }
    }
  }
}

function onShow() {
  animate.value = true;
}

async function addModel() {
  const previousModel = globalSetup.modelSettings.llm_model
  const is_in_models = models.models.some((model) => model.name === modelRequest.value)

  if (!is_in_models) {
    const url_exists = await urlExists(modelRequest.value);
    if (url_exists) {
      addModelError.value = false
      const is_llm = await isLLM(modelRequest.value);
      if (!is_llm) {
        emits("showWarning", i18nState.WARNING_MODEL_TYPE_WRONG, async() => {
          await registerModel();
          emits("callCheckModel");
          closeAdd();
        });
      } else {
        await registerModel()
        emits("callCheckModel");
        closeAdd();
      }
    } else {
        globalSetup.modelSettings.llm_model = previousModel
        addModelErrorMessage.value = i18nState.ERROR_REPO_NOT_EXISTS
        addModelError.value = true;
      }
  } else {
    globalSetup.modelSettings.llm_model = previousModel
    addModelErrorMessage.value = i18nState.ERROR_ALREADY_IN_MODELS
    addModelError.value = true;
  }
}

async function registerModel() {
  userModels.push({name: modelRequest.value, type: 'llm', downloaded: false})
  await models.refreshModels()
  globalSetup.modelSettings.llm_model = modelRequest.value;
}

async function urlExists(repo_id: string) {
  const response = await fetch(`${globalSetup.apiHost}/api/checkHFRepoExists?repo_id=${repo_id}`)
  const data = await response.json()
  return data.exists;
}

async function isLLM(repo_id: string) {
  const response = await fetch(`${globalSetup.apiHost}/api/isLLM?repo_id=${repo_id}`)
  const data = await response.json()
  return data.isllm
}

function closeAdd() {
  addModelErrorMessage.value = "";
  addModelError.value = false;
  modelRequest.value = "";
  emits("close");
}

defineExpose({ onShow });

</script>