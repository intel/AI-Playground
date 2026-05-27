<template>
  <div class="flex flex-col gap-6 p-1">
    <PresetSelector
      :categories="categories"
      :model-value="presetsStore.activePresetName || undefined"
      @update:model-value="handlePresetChange"
      @update:variant="handleVariantChange"
    />

    <TooltipProvider :delay-duration="200">
      <div class="flex flex-col gap-4">
        <!-- Backend selector - only shown when the active preset declares variants for
             multiple backends. Mirrors SettingsChat.vue's dropdown pattern. -->
        <div v-if="!isBackendLocked" class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">Backend</Label>
          <drop-down-new
            title="Select Backend"
            :value="activeBackend"
            :items="backendItems"
            @change="handleBackendChange"
          ></drop-down-new>
        </div>

        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">
            {{ languages.DEVICE }}
          </Label>
          <drop-down-new
            v-if="usesInProcessOpenVINO"
            :title="languages.SETTINGS_INFERENCE_DEVICE"
            :value="inProcessOvDevice"
            :items="inProcessOvDeviceItems"
            @change="setInProcessOvDevice"
          ></drop-down-new>
          <DeviceSelector
            v-else
            :backend="deviceSelectorBackend"
            :allowed-device-prefixes="deviceSelectorAllowedPrefixes"
          />
        </div>

        <div class="flex flex-col gap-2">
          <AspectRatioPicker
            v-if="modifiableOrDisplayed('resolution')"
            :disabled="!modifiable('resolution')"
          />
        </div>

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

        <ComfyDynamic></ComfyDynamic>

        <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
          <button class="mt-4" @click="imageGeneration.resetActivePresetSettings">
            <div class="svg-icon i-refresh">Reset</div>
            {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
          </button>
        </div>

        <div
          v-if="currentPreset?.type === 'comfy' && currentPreset?.backend === 'comfyui'"
          class="max-w-md mx-auto flex items-center gap-2"
        >
          <Button variant="outline" class="flex-1 w-full" @click="openComfyUiInBrowser">
            Open ComfyUI
          </Button>
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="right" class="max-w-[300px] text-sm text-justify">
              {{ languages.SETTINGS_IMAGE_INFO_COMFYUI }}
            </TooltipContent>
          </Tooltip>
        </div>

        <!-- todo: needs to actually do something -->
        <Button variant="outline" class="max-w-md mx-auto"> Create New Preset</Button>
      </div>
    </TooltipProvider>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import DeviceSelector from '@/components/DeviceSelector.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import RandomNumber from '@/components/RandomNumber.vue'
import {
  backendToService,
  useImageGenerationPresets,
} from '@/assets/js/store/imageGenerationPresets.ts'
import ComfyDynamic from '@/components/SettingsImageComfyDynamic.vue'
import { usePresets } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { useBackendServices } from '@/assets/js/store/backendServices'
import * as toast from '@/assets/js/toast'
import AspectRatioPicker from './AspectRatioPicker.vue'
import PresetSelector from './PresetSelector.vue'

interface Props {
  categories: string[]
  title: string
}

const _props = defineProps<Props>()

const imageGeneration = useImageGenerationPresets()
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const backendServices = useBackendServices()

// Friendly labels for backends shown in the dropdown. Add more as new backend ids
// (e.g. 'tensorrt') are introduced via variant.backend.
const BACKEND_DISPLAY_NAME: Record<string, string> = {
  comfyui: 'ComfyUI',
  openvino: 'OpenVINO',
}
// Map backend id (as written on a variant) -> the underlying service whose running
// state drives the green/grey dot in the dropdown. Mirrors backendToService for chat.
const BACKEND_TO_SERVICE: Record<string, BackendServiceName | undefined> = {
  comfyui: 'comfyui-backend',
  openvino: 'openvino-backend',
}

async function openComfyUiInBrowser() {
  const result = await window.electronAPI.comfyui.openInBrowser()
  if (!result.success) {
    toast.error(result.error ?? 'Failed to open ComfyUI')
  }
}

const currentPreset = computed(() => {
  // Use the variant-merged preset so a swap to e.g. the OpenVINO variant immediately
  // reflects in `presetRequiresOvms` (and thus in the device-selector backend).
  return presetsStore.activePresetWithVariant ?? presetsStore.activePreset
})

// OVMS-backed presets call the OpenAI-compatible image API served by openvino-backend
// (OVMS), so the device picker should drive the openvino-backend device — picking a
// device there causes OVMS to be restarted with that device. Other ComfyUI presets
// keep showing comfyui-backend devices.
const presetRequiresOvms = computed(() => {
  const preset = currentPreset.value
  if (!preset || preset.type !== 'comfy') return false
  const workflow = preset.comfyUiApiWorkflow ?? {}
  return Object.values(workflow).some((node) => {
    const classType = (node as { class_type?: unknown })?.class_type
    return typeof classType === 'string' && classType.startsWith('OpenAICompatible')
  })
})

// True when the active variant runs OpenVINO in-process inside ComfyUI
// (the OpenVINO upscale variant). For these, the global Device dropdown
// drives the workflow node's `device` input directly instead of restarting
// any backend service.
const usesInProcessOpenVINO = computed(() => {
  const preset = currentPreset.value
  if (!preset || preset.type !== 'comfy') return false
  const workflow = preset.comfyUiApiWorkflow ?? {}
  return Object.values(workflow).some((node) => {
    const classType = (node as { class_type?: unknown })?.class_type
    return classType === 'OpenVINOImageUpscale'
  })
})

const IN_PROCESS_OV_DEVICE_INPUT = { nodeTitle: 'OpenVINO Upscale', nodeInput: 'device' } as const
const FALLBACK_OV_DEVICES = ['AUTO', 'CPU', 'GPU', 'NPU'] as const
const DEFAULT_OV_IMAGE_GEN_DEVICES = ['CPU', 'GPU'] as const

// settings.json -> openvinoImageGenDevices. Filters which OpenVINO devices
// appear in image-gen device dropdowns (in-process upscale + OVMS variants).
// Prefix-matched, case-insensitive. Default excludes NPU because RealESRGAN
// and SDXL exceed practical NPU memory budgets on most shipping hardware;
// override per-machine via settings.json to re-enable.
const openvinoImageGenDevicePrefixes = ref<string[]>([...DEFAULT_OV_IMAGE_GEN_DEVICES])
onMounted(async () => {
  try {
    const settings = await window.electronAPI.getLocalSettings()
    if (
      Array.isArray(settings.openvinoImageGenDevices) &&
      settings.openvinoImageGenDevices.length > 0
    ) {
      openvinoImageGenDevicePrefixes.value = settings.openvinoImageGenDevices
    }
  } catch (err) {
    console.warn('Failed to load openvinoImageGenDevices, using default', err)
  }
})

function deviceMatchesAllowedPrefixes(deviceId: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true
  const id = deviceId.toUpperCase()
  return prefixes.some((p) => {
    const upper = p.trim().toUpperCase()
    return upper.length > 0 && id.startsWith(upper)
  })
}

const inProcessOvDeviceItems = computed(() => {
  // Prefer real device introspection from openvino-backend when installed
  // (so e.g. NPU only shows when the platform actually has one). Fall back
  // to a static list otherwise — the in-process node will surface a real
  // OpenVINO error if the device is unavailable at compile time.
  const ovInfo = backendServices.info.find((s) => s.serviceName === 'openvino-backend')
  const installed = ovInfo && ovInfo.status !== 'notInstalled'
  const allowed = openvinoImageGenDevicePrefixes.value
  const items =
    installed && ovInfo.devices.length > 0
      ? ovInfo.devices.map((d) => ({ label: `${d.id}: ${d.name}`, value: d.id, active: true }))
      : FALLBACK_OV_DEVICES.map((id) => ({ label: id, value: id, active: true }))
  return items.filter((item) => deviceMatchesAllowedPrefixes(item.value, allowed))
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

// Auto-heal a stale in-process OpenVINO upscale device pick: if the persisted
// `OpenVINO Upscale.device` value is no longer in the filtered list (e.g. a
// fresh install lands on the preset's `AUTO` default while the user's filter
// is `['CPU', 'GPU']`), silently rewrite it to the first allowed item. This
// touches only a workflow comfyInput value, no backend restart involved.
watch(
  [usesInProcessOpenVINO, inProcessOvDeviceItems, inProcessOvDevice],
  ([active, items, current]) => {
    if (!active || items.length === 0) return
    if (items.some((item) => item.value === current)) return
    setInProcessOvDevice(items[0].value)
  },
  { immediate: true },
)

const deviceSelectorBackend = computed<BackendServiceName>(() =>
  presetRequiresOvms.value ? 'openvino-backend' : backendToService[imageGeneration.backend],
)

// Only constrain the OVMS dropdown by the image-gen filter. ComfyUI's native
// CPU/CUDA/XPU device list uses different naming conventions and is unrelated
// to OpenVINO hardware support.
const deviceSelectorAllowedPrefixes = computed<string[] | undefined>(() =>
  deviceSelectorBackend.value === 'openvino-backend'
    ? openvinoImageGenDevicePrefixes.value
    : undefined,
)

async function handlePresetChange(presetName: string) {
  await presetSwitching.switchPreset(presetName, {
    skipModeSwitch: true, // We're already in the correct mode
  })
}

async function handleVariantChange(presetName: string, variantName: string | null) {
  if (variantName) {
    await presetSwitching.switchPreset(presetName, {
      variant: variantName,
      skipModeSwitch: true,
    })
  }
}

// ---- Backend dropdown ------------------------------------------------------

function isBackendServiceRunning(backend: string): boolean {
  const serviceName = BACKEND_TO_SERVICE[backend]
  if (!serviceName) return true // Unknown backend ids: don't gate on a service
  return backendServices.info.find((item) => item.serviceName === serviceName)?.status === 'running'
}

function isVariantServiceUp(serviceName?: string): boolean {
  if (!serviceName) return true
  const info = backendServices.info.find((item) => item.serviceName === serviceName)
  return !!info && info.status !== 'notInstalled'
}

const presetBackends = computed<string[]>(() => {
  const name = presetsStore.activePresetName
  if (!name) return []
  return presetsStore.getDistinctBackendsForPreset(name).filter((backend) => {
    // Always keep the default ComfyUI option.
    if (backend === 'comfyui') return true
    // For non-default backends, show the option if at least one of its variants
    // is currently usable. This correctly keeps `openvino` visible for presets
    // whose OV variant is in-process inside ComfyUI (no `requiresService`) on
    // machines where openvino-backend is not installed, and still hides it for
    // presets whose only OV variants depend on OVMS (the SDXL/inpaint family).
    const variants = presetsStore.getVariantsForBackend(name, backend)
    return variants.some((v) => isVariantServiceUp(v.requiresService))
  })
})

const backendItems = computed(() =>
  presetBackends.value.map((backend) => ({
    label: BACKEND_DISPLAY_NAME[backend] ?? backend,
    value: backend,
    active: isBackendServiceRunning(backend),
  })),
)

const isBackendLocked = computed(() => presetBackends.value.length <= 1)

const activeBackend = computed<string>(() => {
  const name = presetsStore.activePresetName
  if (!name) return 'comfyui'
  return presetsStore.getActiveBackend(name) ?? 'comfyui'
})

async function handleBackendChange(backend: string) {
  const name = presetsStore.activePresetName
  if (!name) return
  if (backend === activeBackend.value) return
  const variantName = presetsStore.pickInitialVariantForBackend(name, backend)
  if (!variantName) return
  await presetSwitching.switchPreset(name, {
    variant: variantName,
    skipModeSwitch: true,
  })
}

// Auto-heal a stuck backend selection: if the user previously chose a variant
// whose backend is no longer in `presetBackends` (e.g. they picked the OVMS
// SDXL variant, then later uninstalled openvino-backend), the Backend dropdown
// would vanish and leave the preset stuck on a dead variant. Switch them to
// the first allowed backend so the preset becomes usable again.
watch(
  [() => presetsStore.activePresetName, presetBackends, activeBackend],
  async ([name, allowed, current]) => {
    if (!name || allowed.length === 0) return
    if (allowed.includes(current)) return
    const fallbackBackend = allowed[0]
    const fallbackVariant = presetsStore.pickInitialVariantForBackend(name, fallbackBackend)
    if (!fallbackVariant) return
    await presetSwitching.switchPreset(name, {
      variant: fallbackVariant,
      skipModeSwitch: true,
    })
  },
  { immediate: true },
)

const modifiableOrDisplayed = (settingName: string) =>
  imageGeneration.settingIsRelevant(settingName)

const modifiable = (settingName: string) => imageGeneration.isModifiable(settingName)
</script>
