<template>
  <div class="dialog-container z-10">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/55  flex justify-center items-center"
    >
      <div
        class="py-10 px-20 w-500px flex flex-col items-center justify-center bg-card shadow-2xl rounded-3xl gap-6 text-foreground"
        :class="{ 'animate-scale-in': animate }"
      >
        <b v-html="i18nState.REQUEST_LLM_MODEL_NAME"></b>
        <div
          class="flex flex-col items-center gap-2 p-4 border border-yellow-600 bg-yellow-600/10 rounded-lg"
        >
          <p>{{ i18nState.REQUEST_LLM_MODEL_DISCLAIMER_1 }}</p>
          <p>{{ i18nState.REQUEST_LLM_MODEL_DISCLAIMER_2 }}</p>
        </div>
        <div class="container flex items-center px-0">
          <Input
            :placeholder="examplePlaceholder"
            v-model="modelRequest"
            @keyup.enter="addModel"
          ></Input>
          <span
            @mouseover="showInfo = true"
            @mouseout="showInfo = false"
            style="vertical-align: middle"
            class="svg-icon i-info w-7 h-7 px-6"
          ></span>
        </div>
        <span v-if="showInfo" class="absolute bg-background shadow-lg border border-border rounded-lg p-2.5 z-10 w-0.6">
          <p v-html="i18nState.REQUEST_LLM_MODEL_DESCRIPTION"></p>
          <ul>
            <li>{{ exampleModelName }}</li>
          </ul>
        </span>

        <!-- Advanced Settings (Optional) -->
        <div class="w-full flex flex-col gap-3 pt-4 border-t border-border">
          <p class="text-sm font-medium text-muted-foreground">
            Specify Model Capabilities (Optional)
          </p>

          <!-- Capability Checkboxes -->
          <div class="grid grid-cols-2 gap-3">
            <div class="flex items-center gap-2">
              <Checkbox id="vision" v-model="supportsVision" />
              <Label for="vision">Vision</Label>
            </div>
            <div class="flex items-center gap-2">
              <Checkbox id="tool-calling" v-model="supportsToolCalling" />
              <Label for="tool-calling">Tool Calling</Label>
            </div>
            <div class="flex items-center gap-2">
              <Checkbox id="reasoning" v-model="supportsReasoning" />
              <Label for="reasoning">Reasoning</Label>
            </div>
            <div v-if="showNpuSupportCheckbox" class="flex items-center gap-2">
              <Checkbox id="npu-support" v-model="npuSupport" />
              <Label for="npu-support">NPU Support</Label>
            </div>
          </div>

          <!-- Max Context Size -->
          <div class="flex flex-col gap-2">
            <Label class="text-sm font-medium">Max Context Size (tokens)</Label>
            <Input
              type="number"
              v-model="maxContextSize"
              placeholder="32768"
              min="1"
              @keyup.enter="addModel"
            />
          </div>

          <!-- Vision Model (Optional) - Disabled when vision is not enabled or backend is not llamaCPP -->
          <div class="w-full flex flex-col gap-2">
            <Label class="text-sm font-medium">
              {{ i18nState.REQUEST_LLM_VISION_MODEL_OPTIONAL }}
            </Label>
            <div class="container flex items-center px-0">
              <Input
                :placeholder="i18nState.COM_LLM_HF_PROMPT_GGUF"
                v-model="visionModelRequest"
                :disabled="!isVisionModelInputEnabled"
                class="disabled:opacity-50 disabled:cursor-not-allowed"
                @keyup.enter="addModel"
              ></Input>
              <span
                @mouseover="showVisionInfo = true"
                @mouseout="showVisionInfo = false"
                style="vertical-align: middle"
                class="svg-icon i-info w-7 h-7 px-6"
              ></span>
            </div>
            <span v-if="showVisionInfo" class="absolute bg-background shadow-lg border border-border rounded-lg p-2.5 z-10 w-0.6">
              <p v-html="i18nState.REQUEST_LLM_VISION_MODEL_DESCRIPTION"></p>
            </span>
          </div>
        </div>
        <p v-show="addModelError" style="color: #f44336">{{ addModelErrorMessage }}</p>
        <div class="flex justify-center items-center gap-9">
          <button @click="closeAdd" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_CLOSE }}
          </button>
          <button @click="addModel" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_ADD }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Input } from '@/components/ui/aipgInput'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { useI18N } from '@/assets/js/store/i18n'
import { useModels } from '@/assets/js/store/models'
import { useTextInference } from '@/assets/js/store/textInference'

const i18nState = useI18N().state
const textInference = useTextInference()
const models = useModels()
const modelRequest = ref('')
const visionModelRequest = ref('')
const addModelErrorMessage = ref('')
const showInfo = ref(false)
const showVisionInfo = ref(false)
const addModelError = ref(false)
const animate = ref(false)

// Capability checkboxes
const supportsVision = ref(false)
const supportsToolCalling = ref(false)
const supportsReasoning = ref(false)
const npuSupport = ref(false)
const maxContextSize = ref('32768')

const emits = defineEmits<{
  (e: 'close'): void
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

// Access backend as a reactive computed to ensure updates
const currentBackend = computed(() => textInference.backend)

const isVisionModelInputEnabled = computed(() => supportsVision.value && currentBackend.value === 'llamaCPP')

// Show NPU Support checkbox only for OpenVINO backend
const showNpuSupportCheckbox = computed(() => currentBackend.value === 'openVINO')

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

  // Trim input values to remove leading/trailing whitespace
  const trimmedModelRequest = modelRequest.value.trim()
  const trimmedVisionModelRequest = visionModelRequest.value.trim()

  if (!isValidModelName(trimmedModelRequest)) {
    cancelAndShowWarning('Please provide a valid model reference.')
    return
  }

  // Validate vision model if provided
  if (trimmedVisionModelRequest && !isValidModelName(trimmedVisionModelRequest)) {
    cancelAndShowWarning('Please provide a valid vision model reference.')
    return
  }

  const isInModels = models.models.some((model) => model.name === trimmedModelRequest)

  if (isInModels) {
    cancelAndShowWarning(i18nState.ERROR_ALREADY_IN_MODELS)
    return
  }

  const urlExists = await models.checkIfHuggingFaceUrlExists(trimmedModelRequest)
  if (!urlExists) {
    cancelAndShowWarning(i18nState.ERROR_REPO_NOT_EXISTS)
    return
  }

  // Check vision model URL if provided
  if (trimmedVisionModelRequest) {
    const visionUrlExists = await models.checkIfHuggingFaceUrlExists(trimmedVisionModelRequest)
    if (!visionUrlExists) {
      cancelAndShowWarning('Vision model repository does not exist.')
      return
    }
  }

  addModelError.value = false

  const downloadNewModel = async () => {
    await models.addModel({
      name: trimmedModelRequest,
      type: textInference.backend,
      backend: textInference.backend,
      downloaded: false,
      mmproj: trimmedVisionModelRequest || undefined,
      supportsVision: supportsVision.value || undefined,
      supportsToolCalling: supportsToolCalling.value || undefined,
      supportsReasoning: supportsReasoning.value || undefined,
      npuSupport: npuSupport.value || undefined,
      maxContextSize: maxContextSize.value ? parseInt(maxContextSize.value, 10) : undefined,
      isPredefined: false,
    })
    textInference.selectModel(textInference.backend, trimmedModelRequest)
    textInference.checkModelAvailability()
    closeAdd()
  }

  downloadNewModel()
}

function closeAdd() {
  addModelErrorMessage.value = ''
  addModelError.value = false
  modelRequest.value = ''
  visionModelRequest.value = ''
  supportsVision.value = false
  supportsToolCalling.value = false
  supportsReasoning.value = false
  npuSupport.value = false
  maxContextSize.value = '32768'
  emits('close')
}

defineExpose({ onShow })
</script>

<style>
ul {
  list-style-type: disc;
  padding-left: 20px;
}
</style>
