<script setup lang="ts">
// Add a model the catalog does not list. Both what it is (LLM or embedding) and
// which backend runs it are asked for here: the dialog used to inherit the Chat
// backend, so an OpenVINO model could only be added by first switching Chat.
import { computed, onMounted, ref } from 'vue'
import { Input } from '@/components/ui/aipgInput'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import ModelCapabilityFields from '@/components/models/ModelCapabilityFields.vue'
import { pickDefined } from '@/assets/js/models/overrides'
import { modelEntryId, pathKeyForCatalogModel } from '@/assets/js/models/library'
import { useI18N } from '@/assets/js/store/i18n'
import { useModels } from '@/assets/js/store/models'
import { useModelLibrary } from '@/assets/js/store/modelLibrary'
import { useProductMode } from '@/assets/js/store/productMode'
import { useTextInference, type LlmBackend } from '@/assets/js/store/textInference'
import { useErrors } from '@/assets/js/store/errors'
import type { ModelCapabilityValues } from '@/assets/js/models/types'

type AddUseCase = 'llm' | 'embedding'
type LocalBackend = Exclude<LlmBackend, 'cloud'>

const emit = defineEmits<{ (e: 'close'): void }>()

const i18nState = useI18N().state
const models = useModels()
const library = useModelLibrary()
const productMode = useProductMode()
const textInference = useTextInference()
const errors = useErrors()

// `largeMoe` is stated rather than left unset: its checkbox is hidden without a
// Phison SSD, so a model added there must not be able to arrive as a large MoE.
const llmCapabilityDefaults = (): ModelCapabilityValues => ({ largeMoe: false })

const useCase = ref<AddUseCase>('llm')
// Cloud has nothing to add locally, so a cloud chat session starts on llama.cpp.
const backend = ref<LocalBackend>(textInference.backend === 'openVINO' ? 'openVINO' : 'llamaCPP')
const modelName = ref('')
const capabilities = ref<ModelCapabilityValues>(llmCapabilityDefaults())
const errorMessage = ref('')
const busy = ref(false)
const animate = ref(false)

onMounted(() => {
  animate.value = true
  // An NVIDIA install runs no OVMS, and its models are filtered out of the table
  // — adding one would write a row nobody can see.
  if (productMode.isNvidiaModeSelected) backend.value = 'llamaCPP'
})

const openVinoAvailable = computed(() => !productMode.isNvidiaModeSelected)
const serviceBackend = computed(() =>
  backend.value === 'openVINO' ? ('openvino' as const) : ('llama_cpp' as const),
)

// llama.cpp loads one file out of a repo, OVMS a whole repo directory.
const needsFilePath = computed(() => backend.value === 'llamaCPP')
const placeholder = computed(() =>
  needsFilePath.value ? i18nState.COM_LLM_HF_PROMPT_GGUF : i18nState.COM_LLM_HF_PROMPT,
)
const example = computed(() =>
  needsFilePath.value ? i18nState.REQUEST_LLM_SINGLE_EXAMPLE : i18nState.REQUEST_LLM_MODEL_EXAMPLE,
)

const isValidModelName = (name: string) =>
  needsFilePath.value ? name.split('/').length >= 3 : name.split('/').length === 2

function selectUseCase(value: string) {
  const next = value as AddUseCase
  if (next === useCase.value) return
  useCase.value = next
  // Capabilities describe a chat model; an embedding server reads none of them.
  capabilities.value = next === 'embedding' ? {} : llmCapabilityDefaults()
}

function selectBackend(value: string) {
  backend.value = value as LocalBackend
  // NPU support and the tool parser are OpenVINO's, the projector is llama.cpp's:
  // keeping them across a backend switch would submit a field the form no longer
  // shows.
  capabilities.value = {
    ...capabilities.value,
    npuSupport: undefined,
    toolParser: undefined,
    mmproj: undefined,
  }
}

async function submit() {
  if (busy.value) return
  const name = modelName.value.trim()
  const mmproj = capabilities.value.mmproj?.trim()

  if (!isValidModelName(name)) {
    errorMessage.value = i18nState.MODEL_MANAGER_ADD_INVALID_NAME
    return
  }
  if (mmproj && !isValidModelName(mmproj)) {
    errorMessage.value = i18nState.MODEL_MANAGER_ADD_INVALID_VISION_NAME
    return
  }
  if (models.models.some((model) => model.name === name)) {
    errorMessage.value = i18nState.ERROR_ALREADY_IN_MODELS
    return
  }

  busy.value = true
  try {
    if (!(await models.checkIfHuggingFaceUrlExists(name))) {
      errorMessage.value = i18nState.ERROR_REPO_NOT_EXISTS
      return
    }
    if (mmproj && !(await models.checkIfHuggingFaceUrlExists(mmproj))) {
      errorMessage.value = i18nState.MODEL_MANAGER_ADD_VISION_NOT_FOUND
      return
    }
    errorMessage.value = ''

    const type = useCase.value === 'embedding' ? ('embedding' as const) : backend.value
    await models.addModel({
      ...pickDefined(capabilities.value),
      name,
      type,
      backend: backend.value,
      downloaded: false,
      isPredefined: false,
    })

    // Selecting is only safe where it cannot move the user's Chat backend under
    // them: the newly added model becomes active for the backend it belongs to.
    if (useCase.value === 'embedding') {
      textInference.selectEmbeddingModel(backend.value, name)
    } else if (textInference.backend === backend.value) {
      textInference.selectModel(backend.value, name)
    }

    // The table has to know the row before it can be downloaded through it.
    await library.refresh()
    const placement = pathKeyForCatalogModel(type, backend.value)
    if (placement) library.downloadOne(modelEntryId(placement.pathKey, name))
    emit('close')
  } catch (error) {
    errors.report(error, {
      category: 'model',
      code: 'model/add-failed',
      userMessage: i18nState.MODEL_MANAGER_ADD_FAILED,
    })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="dialog-container z-20">
    <div
      class="dialog-mask absolute left-0 top-0 flex h-full w-full items-center justify-center bg-background/70"
    >
      <div
        role="dialog"
        aria-modal="true"
        :aria-label="languages.REQUEST_LLM_MODEL_NAME"
        class="flex max-h-[85vh] w-140 flex-col gap-4 overflow-y-auto rounded-2xl bg-card p-8 text-foreground shadow-2xl"
        :class="{ 'animate-scale-in': animate }"
      >
        <h2 class="text-lg font-semibold">{{ languages.REQUEST_LLM_MODEL_NAME }}</h2>

        <div class="flex flex-col gap-1 rounded-lg border border-yellow-600 bg-yellow-600/10 p-3">
          <p class="text-sm">{{ languages.REQUEST_LLM_MODEL_DISCLAIMER_1 }}</p>
          <p class="text-sm">{{ languages.REQUEST_LLM_MODEL_DISCLAIMER_2 }}</p>
        </div>

        <div class="flex flex-col gap-2">
          <Label id="add-model-use-case-label" class="text-sm font-medium">
            {{ languages.MODEL_MANAGER_ADD_USE_CASE }}
          </Label>
          <RadioGroup
            :model-value="useCase"
            class="flex gap-6"
            aria-labelledby="add-model-use-case-label"
            @update:model-value="(value) => selectUseCase(String(value))"
          >
            <div class="flex items-center gap-2">
              <RadioGroupItem id="add-model-use-case-llm" value="llm" />
              <Label for="add-model-use-case-llm" class="cursor-pointer">
                {{ languages.MODEL_MANAGER_USE_CASE_LLM }}
              </Label>
            </div>
            <div class="flex items-center gap-2">
              <RadioGroupItem id="add-model-use-case-embedding" value="embedding" />
              <Label for="add-model-use-case-embedding" class="cursor-pointer">
                {{ languages.MODEL_MANAGER_USE_CASE_EMBEDDING }}
              </Label>
            </div>
          </RadioGroup>
        </div>

        <div class="flex flex-col gap-2">
          <Label id="add-model-backend-label" class="text-sm font-medium">
            {{ languages.MODEL_MANAGER_ADD_BACKEND }}
          </Label>
          <RadioGroup
            :model-value="backend"
            class="flex gap-6"
            aria-labelledby="add-model-backend-label"
            @update:model-value="(value) => selectBackend(String(value))"
          >
            <div class="flex items-center gap-2">
              <RadioGroupItem id="add-model-backend-llamacpp" value="llamaCPP" />
              <Label for="add-model-backend-llamacpp" class="cursor-pointer">llama.cpp</Label>
            </div>
            <div v-if="openVinoAvailable" class="flex items-center gap-2">
              <RadioGroupItem id="add-model-backend-openvino" value="openVINO" />
              <Label for="add-model-backend-openvino" class="cursor-pointer">OpenVINO</Label>
            </div>
          </RadioGroup>
        </div>

        <div class="flex flex-col gap-2">
          <Label for="add-model-name" class="text-sm font-medium">
            {{ languages.MODEL_MANAGER_ADD_REPOSITORY }}
          </Label>
          <Input
            id="add-model-name"
            v-model="modelName"
            :placeholder="placeholder"
            @keyup.enter="submit"
          />
          <p class="text-xs text-muted-foreground">
            {{ languages.REQUEST_LLM_MODEL_DESCRIPTION }} {{ example }}
          </p>
        </div>

        <div v-if="useCase === 'llm'" class="flex flex-col gap-3 border-t border-border pt-4">
          <p class="text-sm font-medium text-muted-foreground">
            {{ languages.MODEL_MANAGER_ADD_CAPABILITIES }}
          </p>
          <ModelCapabilityFields
            v-model="capabilities"
            :service-backend="serviceBackend"
            show-advanced
            id-prefix="add-capability"
          />
        </div>

        <p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>

        <div class="flex justify-end gap-3">
          <button class="rounded bg-muted px-4 py-1.5 text-sm" @click="emit('close')">
            {{ languages.COM_CANCEL }}
          </button>
          <button
            class="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            :disabled="busy"
            @click="submit"
          >
            {{ languages.COM_ADD }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
