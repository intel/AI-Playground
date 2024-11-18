<template>
    <div class="dialog-container z-10">
        <div class="dialog-mask absolute left-0 top-0 w-full h-full bg-black/55 flex justify-center items-center">
            <div class="py-20 px-20 w-768px flex flex-col items-center justify-center bg-gray-600 rounded-3xl gap-8 text-white"
                :class="{ 'animate-scale-in': animate }">
              <p>{{ i18nState.REQUEST_LLM_MODEL_NAME }}</p>
              <textarea class="rounded-xl border border-color-spilter flex-auto w-full h-auto resize-none"
                        :placeholder="languages.COM_LLM_HF_PROMPT" v-model="modelRequest" @keydown="fastGenerate"></textarea>
              <p v-show = "addModelError" style="color: #F44336;">{{ addModelErrorMessage }}</p>
              <div class="flex justify-center items-center gap-9">
                <button @click="closeAdd" class="rounded border bg-red-500 py-1 px-4">{{ i18nState.COM_CLOSE }}</button>
                <button @click="addModel" class="rounded border bg-red-500 py-1 px-4">{{ i18nState.COM_ADD }}</button>
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
    (e: "callCheckModel"): void
}>();


onDeactivated(() => {
    animate.value = false;
})

function fastGenerate(e: KeyboardEvent) {
  // ToDo: Live-Check if model available
  if (e.code == "Enter") {
    if (e.ctrlKey || e.shiftKey || e.altKey) {
      modelRequest.value += "\n";
    } else {
      e.preventDefault();
      addModel()
    }
  }
}

async function addModel() {
  const previousModel = globalSetup.modelSettings.llm_model
  const url_exists = await urlExists(modelRequest.value);

  const is_in_models = models.models.some((model) => model.name === modelRequest.value)

  if (url_exists && !is_in_models) {
    userModels.push({ name: modelRequest.value, type: 'llm', downloaded: false })
    await models.refreshModels()
    console.log(models.models)
    globalSetup.modelSettings.llm_model = modelRequest.value;
    emits("callCheckModel");
    emits("close")
  } else if (is_in_models) {
    globalSetup.modelSettings.llm_model = previousModel
    addModelErrorMessage.value = i18nState.ERROR_ALREADY_IN_MODELS
    addModelError.value = true;
  } else {
    globalSetup.modelSettings.llm_model = previousModel
    addModelErrorMessage.value = i18nState.ERROR_REPO_NOT_EXISTS
    addModelError.value = true;
  }
}


async function urlExists(repo_id: string) {
  const response = await fetch(`${globalSetup.apiHost}/api/checkURLExists`, {
    method: "POST",
    body: JSON.stringify(repo_id),
    headers: {
      "Content-Type": "application/json"
    }})

  const data = await response.json()
  return data.exists;
}

function closeAdd() {
  addModelError.value = false;
  modelRequest.value = "";
  emits("close");
}

</script>
<style scoped>
table {
    border-collapse: separate;
    border-spacing: 10px;
}
</style>