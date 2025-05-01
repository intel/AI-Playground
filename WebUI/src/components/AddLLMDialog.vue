<template>
  <div class="dialog-container z-10">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-black/55 flex justify-center items-center"
    >
      <div
        class="py-10 px-20 w-500px flex flex-col items-center justify-center bg-gray-600 rounded-3xl gap-6 text-white"
        :class="{ 'animate-scale-in': animate }"
      >
        <b v-html="i18nState.REQUEST_LLM_MODEL_NAME"></b>
        <div
          class="flex flex-col items-center gap-2 p-4 border border-yellow-600 bg-yellow-600/10 rounded-lg"
        >
          <p>{{ i18nState.REQUEST_LLM_MODEL_DISCLAIMER_1 }}</p>
          <p>{{ i18nState.REQUEST_LLM_MODEL_DISCLAIMER_2 }}</p>
        </div>
        <div class="container flex">
          <span
            @mouseover="showInfo = true"
            @mouseout="showInfo = false"
            style="vertical-align: middle"
            class="svg-icon i-info w-7 h-7 px-6"
          ></span>
          <Input
            :placeholder="examplePlaceholder"
            v-model="modelRequest"
            @keyup.enter="addModel"
          ></Input>
        </div>
        <span v-if="showInfo" class="hover-box w-0.6">
          <p v-html="i18nState.REQUEST_LLM_MODEL_DESCRIPTION"></p>
          <ul>
            <li>{{ exampleModelName }}</li>
          </ul>
        </span>
        <p v-show="addModelError" style="color: #f44336">{{ addModelErrorMessage }}</p>
        <div class="flex justify-center items-center gap-9">
          <button @click="closeAdd" class="bg-color-control-bg py-1 px-4 rounded">
            {{ i18nState.COM_CLOSE }}
          </button>
          <button @click="addModel" class="bg-color-control-bg py-1 px-4 rounded">
            {{ i18nState.COM_ADD }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Input } from '@/components/ui/aipgInput'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useI18N } from '@/assets/js/store/i18n'
import { useModels } from '@/assets/js/store/models'
import { useTextInference } from '@/assets/js/store/textInference'

const i18nState = useI18N().state
const globalSetup = useGlobalSetup()
const textInference = useTextInference()
const models = useModels()
const modelRequest = ref('')
const addModelErrorMessage = ref('')
const showInfo = ref(false)
const addModelError = ref(false)
const animate = ref(false)
const emits = defineEmits<{
  (e: 'close'): void
  (e: 'callCheckModel'): void
  (e: 'showWarning', warning: string, func: () => void): void
}>()

const exampleModelName = computed(() =>
  textInference.backend === 'llamaCPP'
    ? i18nState.REQUEST_LLM_SINGLE_EXAMPLE
    : i18nState.REQUEST_LLM_MODEL_EXAMPLE,
)
const examplePlaceholder = computed(() =>
  textInference.backend === 'llamaCPP'
    ? i18nState.COM_LLM_HF_PROMPT_GGUF
    : i18nState.COM_LLM_HF_PROMPT,
)

const isValidModelName = (name: string) =>
  textInference.backend === 'llamaCPP' ? name.split('/').length >= 3 : name.split('/').length === 2

function onShow() {
  animate.value = true
}

async function addModel() {
  const cancelAndShowWarning = (text: string) => {
    addModelErrorMessage.value = text
    addModelError.value = true
  }

  if (!isValidModelName(modelRequest.value)) {
    cancelAndShowWarning('Please provide a valid model reference.')
    return
  }

  const isInModels = models.models.some((model) => model.name === modelRequest.value)

  if (isInModels) {
    cancelAndShowWarning(i18nState.ERROR_ALREADY_IN_MODELS)
    return
  }

  const urlExists = await models.checkIfHuggingFaceUrlExists(modelRequest.value)
  if (!urlExists) {
    cancelAndShowWarning(i18nState.ERROR_REPO_NOT_EXISTS)
    return
  }

  addModelError.value = false

  const isLlm = await isLLM(modelRequest.value)
  const downloadNewModel = async () => {
    await models.addModel({
      name: modelRequest.value,
      type: textInference.backend,
      downloaded: false,
      default: false,
    })
    textInference.selectModel(textInference.backend, modelRequest.value)
    emits('callCheckModel')
    closeAdd()
  }

  if (!isLlm) {
    emits('showWarning', i18nState.WARNING_MODEL_TYPE_WRONG, downloadNewModel)
  } else {
    downloadNewModel()
  }
}

async function isLLM(repo_id: string) {
  const response = await fetch(`${globalSetup.apiHost}/api/isLLM?repo_id=${repo_id}`)
  const data = await response.json()
  return data.isllm
}

function closeAdd() {
  addModelErrorMessage.value = ''
  addModelError.value = false
  modelRequest.value = ''
  emits('close')
}

defineExpose({ onShow })
</script>

<style>
ul {
  list-style-type: disc;
  padding-left: 20px;
}
.hover-box {
  position: absolute;
  background-color: rgba(90, 90, 90, 0.91);
  border: 1px solid #000000;
  padding: 10px;
  border-radius: 10px;
  z-index: 1;
}
</style>
