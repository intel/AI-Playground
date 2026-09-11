<script setup lang="ts">
// The capability form, shared by the Add Model dialog and the Model Management
// capability editor so the two can't drift apart.
import { computed, ref, watch } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/aipgInput'
import { Label } from '@/components/ui/label'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useI18N } from '@/assets/js/store/i18n'
import { ovmsToolParsers } from '@/types/shared'
import type { ModelCapabilityValues, ModelServiceBackend } from '@/assets/js/models/types'
import DropDownNew from '@/components/DropDownNew.vue'

const props = defineProps<{
  modelValue: ModelCapabilityValues
  /** Backend of the model being edited; gates the OpenVINO-only fields. */
  serviceBackend: ModelServiceBackend
  /** Show the fields that only make sense once a model exists (tool parser). */
  showAdvanced?: boolean
  idPrefix?: string
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: ModelCapabilityValues): void }>()

const backendServices = useBackendServices()
const i18nState = useI18N().state

const prefix = computed(() => props.idPrefix ?? 'capability')

function set<K extends keyof ModelCapabilityValues>(key: K, value: ModelCapabilityValues[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

/** Checkboxes emit `false` for "off"; store `undefined` so it stays un-overridden. */
function setFlag(key: keyof ModelCapabilityValues, value: boolean) {
  set(key, (value ? true : undefined) as ModelCapabilityValues[typeof key])
}

// Vision and its projector are set together: an mmproj left behind by an
// un-ticked Vision box turns vision back on by itself, since `refreshModels`
// infers the capability from the projector.
function setVision(value: boolean) {
  emit('update:modelValue', {
    ...props.modelValue,
    supportsVision: value ? true : undefined,
    mmproj: value ? props.modelValue.mmproj : undefined,
  })
}

const isOpenVino = computed(() => props.serviceBackend === 'openvino')
const isLlamaCpp = computed(() => props.serviceBackend === 'llama_cpp')

const mmproj = computed({
  get: () => props.modelValue.mmproj ?? '',
  set: (value: string) => set('mmproj', value.trim() || undefined),
})

// Kept as its own text ref rather than derived straight from the prop: a getter
// that renders `undefined` as '' would wipe the field the moment the user cleared
// it to retype, so "4" on the way to "4096" could never be typed.
const contextSizeText = ref((props.modelValue.maxContextSize ?? '').toString())

watch(
  () => props.modelValue.maxContextSize,
  (value) => {
    // Only follow the prop when it disagrees with what is on screen, so an
    // external reset lands but the user's own typing is never reformatted.
    if ((value ?? '').toString() !== contextSizeText.value) {
      contextSizeText.value = (value ?? '').toString()
    }
  },
)

const contextSize = computed({
  get: () => contextSizeText.value,
  set: (value: string) => {
    contextSizeText.value = value
    const parsed = Number.parseInt(value, 10)
    // Anything that isn't a positive integer means "no override" — including the
    // empty field, which is how the override is cleared.
    set('maxContextSize', Number.isInteger(parsed) && parsed > 0 ? parsed : undefined)
  },
})

// The empty first entry is what makes the parser resettable: without it, picking
// one is a one-way door, since the dropdown offers no way back to "unset".
const toolParserItems = computed(() => [
  { label: i18nState.MODEL_MANAGER_CAP_TOOL_PARSER_DEFAULT, value: '', active: true },
  ...ovmsToolParsers.map((parser) => ({ label: parser, value: parser, active: true })),
])
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="grid grid-cols-2 gap-3">
      <div class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-vision`"
          :model-value="modelValue.supportsVision === true"
          @update:model-value="(v) => setVision(v === true)"
        />
        <Label :for="`${prefix}-vision`">{{ languages.MODEL_MANAGER_CAP_VISION }}</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-tools`"
          :model-value="modelValue.supportsToolCalling === true"
          @update:model-value="(v) => setFlag('supportsToolCalling', v === true)"
        />
        <Label :for="`${prefix}-tools`">{{ languages.MODEL_MANAGER_CAP_TOOLS }}</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-reasoning`"
          :model-value="modelValue.supportsReasoning === true"
          @update:model-value="(v) => setFlag('supportsReasoning', v === true)"
        />
        <Label :for="`${prefix}-reasoning`">{{ languages.MODEL_MANAGER_CAP_REASONING }}</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-thinking`"
          :model-value="modelValue.supportsThinkingToggle === true"
          @update:model-value="(v) => setFlag('supportsThinkingToggle', v === true)"
        />
        <Label :for="`${prefix}-thinking`">{{ languages.MODEL_MANAGER_CAP_THINKING }}</Label>
      </div>
      <div v-if="isOpenVino" class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-npu`"
          :model-value="modelValue.npuSupport === true"
          @update:model-value="(v) => setFlag('npuSupport', v === true)"
        />
        <Label :for="`${prefix}-npu`">{{ languages.MODEL_MANAGER_CAP_NPU }}</Label>
      </div>
    </div>

    <!-- Coding and large MoE are the two boxes whose label cannot carry their
         meaning: one decides which presets offer the model, the other is a
         hardware gate that can hide it everywhere. So they sit outside the grid,
         each with its hint always on screen — a hint shown only once the box is
         ticked comes too late to inform the decision. -->
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-coding`"
          :model-value="modelValue.supportsCoding === true"
          @update:model-value="(v) => setFlag('supportsCoding', v === true)"
        />
        <Label :for="`${prefix}-coding`">{{ languages.MODEL_MANAGER_CAP_CODING }}</Label>
      </div>
      <p class="text-xs text-muted-foreground">
        {{ languages.MODEL_MANAGER_CAP_CODING_HINT }}
      </p>
    </div>

    <!-- Offered only where the hardware is: without a Phison SSD, ticking it can
         only hide the model from every picker. Any value already set is left
         alone rather than cleared, so a catalog model stays marked as large MoE
         on a machine that cannot load it. -->
    <div v-if="showAdvanced && backendServices.phisonSsdDetected" class="flex flex-col gap-1">
      <div class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-large-moe`"
          :model-value="modelValue.largeMoe === true"
          @update:model-value="(v) => setFlag('largeMoe', v === true)"
        />
        <Label :for="`${prefix}-large-moe`">{{ languages.MODEL_MANAGER_CAP_LARGE_MOE }}</Label>
      </div>
      <p class="text-xs text-muted-foreground">
        {{ languages.MODEL_MANAGER_CAP_LARGE_MOE_HINT }}
        {{ languages.MODEL_MANAGER_PHISON_DETECTED }}
      </p>
    </div>

    <!-- The projector is the model's other half, so it belongs wherever vision
         does. Settable only at add time until now, which made a wrong one a
         one-way door. -->
    <div v-if="isLlamaCpp && modelValue.supportsVision" class="flex flex-col gap-2">
      <Label :for="`${prefix}-mmproj`" class="text-sm font-medium">
        {{ languages.REQUEST_LLM_VISION_MODEL_OPTIONAL }}
      </Label>
      <Input
        :id="`${prefix}-mmproj`"
        v-model="mmproj"
        :placeholder="languages.COM_LLM_HF_PROMPT_GGUF"
      />
      <p class="text-xs text-muted-foreground">
        {{ languages.REQUEST_LLM_VISION_MODEL_DESCRIPTION }}
      </p>
    </div>

    <div class="flex flex-col gap-2">
      <Label :for="`${prefix}-context`" class="text-sm font-medium">
        {{ languages.MODEL_MANAGER_CAP_MAX_CONTEXT }}
      </Label>
      <Input :id="`${prefix}-context`" type="number" min="1" v-model="contextSize" />
    </div>

    <!-- OVMS picks 'hermes3' when unset. A wrong parser silently breaks tool
         calling, and until now it could only be fixed by editing models.json. -->
    <div v-if="showAdvanced && isOpenVino" class="flex flex-col gap-2">
      <!-- DropDownNew's trigger is nested inside the component, so the label is
           tied to it through a named group rather than a `for`/`id` pair, the same
           way the library toolbar names its filters. -->
      <Label :id="`${prefix}-tool-parser-label`" class="text-sm font-medium">
        {{ languages.MODEL_MANAGER_CAP_TOOL_PARSER }}
      </Label>
      <div role="group" :aria-labelledby="`${prefix}-tool-parser-label`">
        <DropDownNew
          :items="toolParserItems"
          :value="modelValue.toolParser ?? ''"
          @change="(value: string) => set('toolParser', value || undefined)"
        />
      </div>
      <p class="text-xs text-muted-foreground">
        {{ languages.MODEL_MANAGER_CAP_TOOL_PARSER_HINT }}
      </p>
    </div>
  </div>
</template>
