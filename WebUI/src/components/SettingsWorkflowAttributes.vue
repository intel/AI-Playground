<template>
  <TooltipProvider :delay-duration="200">
    <SettingsTabLayout>
      <!-- The in-process OpenVINO upscale device is a workflow input, so it stays the Session's. -->
      <SettingsRow v-if="usesInProcessOpenVINO" :label="languages.DEVICE">
        <drop-down-new
          :title="languages.SETTINGS_INFERENCE_DEVICE"
          :value="inProcessOvDevice"
          :items="inProcessOvDeviceItems"
          @change="setInProcessOvDevice"
        ></drop-down-new>
      </SettingsRow>

      <AspectRatioPicker
        v-if="modifiableOrDisplayed('resolution')"
        :disabled="!modifiable('resolution')"
      />

      <div
        v-if="modifiableOrDisplayed('inferenceSteps')"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <div class="flex items-center justify-between gap-2 min-w-0 w-[120px]">
          <Label class="whitespace-nowrap truncate min-w-0">
            {{ languages.SETTINGS_MODEL_IMAGE_STEPS }}
          </Label>
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
              {{ languages.SETTINGS_IMAGE_INFO_STEPS }}
            </TooltipContent>
          </Tooltip>
        </div>
        <div class="flex gap-2">
          <Slider
            v-model="imageGeneration.inferenceSteps"
            :min="1"
            :max="50"
            :step="1"
            :disabled="!modifiable('inferenceSteps')"
          />
          <span>{{ imageGeneration.inferenceSteps }}</span>
        </div>
      </div>

      <div
        v-if="modifiableOrDisplayed('batchSize')"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <div class="flex items-center justify-between gap-2 min-w-0 w-[120px]">
          <Label class="whitespace-nowrap truncate min-w-0">
            {{ languages.SETTINGS_MODEL_BATCH_COUNT }}
          </Label>
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
              {{ languages.SETTINGS_IMAGE_INFO_BATCH_COUNT }}
            </TooltipContent>
          </Tooltip>
        </div>
        <div class="flex gap-2">
          <Slider
            v-model="imageGeneration.batchSize"
            :min="1"
            :max="20"
            :step="1"
            :disabled="!modifiable('batchSize')"
          />
          <span>{{ imageGeneration.batchSize }}</span>
        </div>
      </div>

      <div
        v-if="modifiableOrDisplayed('negativePrompt')"
        class="grid grid-cols-[120px_1fr] items-start gap-4"
      >
        <div class="flex items-center justify-between gap-2 min-w-0 w-[120px] mt-2">
          <Label class="whitespace-nowrap truncate min-w-0">
            {{ languages.SETTINGS_MODEL_NEGATIVE_PROMPT }}
          </Label>
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
              {{ languages.SETTINGS_IMAGE_INFO_NEGATIVE_PROMPT }}
            </TooltipContent>
          </Tooltip>
        </div>
        <textarea
          class="h-24 rounded-lg resize-none bg-input border border-border text-foreground p-2"
          v-model="imageGeneration.negativePrompt"
          :disabled="!modifiable('negativePrompt')"
        ></textarea>
      </div>

      <div
        v-if="modifiableOrDisplayed('seed')"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <div class="flex items-center justify-between gap-2 min-w-0 w-[120px]">
          <Label class="whitespace-nowrap truncate min-w-0">
            {{ languages.SETTINGS_MODEL_SEED }}
          </Label>
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
              {{ languages.SETTINGS_IMAGE_INFO_SEED }}
            </TooltipContent>
          </Tooltip>
        </div>
        <random-number
          v-model:value="imageGeneration.seed"
          :default="-1"
          :min="0"
          :max="4294967295"
          :scale="1"
          :disabled="!modifiable('seed')"
        ></random-number>
      </div>

      <div
        v-if="modifiableOrDisplayed('showPreview')"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <div class="flex items-center justify-between gap-2 min-w-0 w-[120px]">
          <Label class="whitespace-nowrap truncate min-w-0">
            {{ languages.SETTINGS_MODEL_SHOW_PREVIEW || 'Show Preview' }}
          </Label>
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
              {{ languages.SETTINGS_IMAGE_INFO_SHOW_PREVIEW }}
            </TooltipContent>
          </Tooltip>
        </div>
        <Checkbox
          :model-value="imageGeneration.showPreview"
          :disabled="!modifiable('showPreview')"
          @update:model-value="(value) => (imageGeneration.showPreview = value === true)"
        />
      </div>

      <ComfyDynamic />

      <template #reset-fallback>
        <WorkflowPresetResetButton />
      </template>
    </SettingsTabLayout>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useI18N } from '@/assets/js/store/i18n'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import AspectRatioPicker from '@/components/AspectRatioPicker.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import RandomNumber from '@/components/RandomNumber.vue'
import ComfyDynamic from '@/components/SettingsImageComfyDynamic.vue'
import SettingsRow from '@/components/SettingsRow.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import WorkflowPresetResetButton from '@/components/WorkflowPresetResetButton.vue'
import { deviceMatchesAllowedPrefixes, useWorkflowDevices } from '@/assets/js/workflowDevices'

const imageGeneration = useImageGenerationPresets()
const backendServices = useBackendServices()
const languages = useI18N().state
const { usesInProcessOpenVINO, openvinoImageGenDevicePrefixes } = useWorkflowDevices()

const IN_PROCESS_OV_DEVICE_INPUT = { nodeTitle: 'OpenVINO Upscale', nodeInput: 'device' } as const
const FALLBACK_OV_DEVICES = ['AUTO', 'CPU', 'GPU', 'NPU'] as const

const inProcessOvDeviceItems = computed(() => {
  // Without openvino-backend installed there is no device introspection; the node itself
  // reports an unavailable device at compile time.
  const ovInfo = backendServices.info.find((s) => s.serviceName === 'openvino-backend')
  const installed = ovInfo && ovInfo.status !== 'notInstalled'
  const items =
    installed && ovInfo.devices.length > 0
      ? ovInfo.devices.map((d) => ({ label: `${d.id}: ${d.name}`, value: d.id, active: true }))
      : FALLBACK_OV_DEVICES.map((id) => ({ label: id, value: id, active: true }))
  return items.filter((item) =>
    deviceMatchesAllowedPrefixes(item.value, openvinoImageGenDevicePrefixes.value),
  )
})

const inProcessOvDeviceComfyInput = computed(() =>
  imageGeneration.comfyInputs.find(
    (i) =>
      i.nodeTitle === IN_PROCESS_OV_DEVICE_INPUT.nodeTitle &&
      i.nodeInput === IN_PROCESS_OV_DEVICE_INPUT.nodeInput,
  ),
)

const inProcessOvDevice = computed<string>(() => {
  const raw = inProcessOvDeviceComfyInput.value?.current.value
  return typeof raw === 'string' && raw.length > 0 ? raw : 'AUTO'
})

function setInProcessOvDevice(value: string) {
  const input = inProcessOvDeviceComfyInput.value
  if (!input) return
  input.current.value = value
}

// A stored pick outside the allowed list (e.g. the preset's `AUTO` default under a
// ['CPU', 'GPU'] filter) is rewritten to the first allowed device.
watch(
  [usesInProcessOpenVINO, inProcessOvDeviceItems, inProcessOvDevice],
  ([active, items, current]) => {
    if (!active || items.length === 0) return
    if (items.some((item) => item.value === current)) return
    setInProcessOvDevice(items[0].value)
  },
  { immediate: true },
)

const modifiableOrDisplayed = (settingName: string) =>
  imageGeneration.settingIsRelevant(settingName)

const modifiable = (settingName: string) => imageGeneration.isModifiable(settingName)
</script>
