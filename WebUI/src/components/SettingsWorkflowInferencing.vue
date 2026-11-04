<template>
  <TooltipProvider :delay-duration="200">
    <SettingsTabLayout>
      <template #picker>
        <PresetSelector
          :categories="categories"
          :model-value="presetsStore.activePresetName || undefined"
          @update:model-value="handlePresetChange"
          @update:variant="handleVariantChange"
        />
      </template>

      <!-- Only shown when the active preset declares variants for more than one backend. -->
      <SettingsRow v-if="!isBackendLocked" label="Backend">
        <drop-down-new
          title="Select Backend"
          :value="activeBackend"
          :items="backendItems"
          @change="handleBackendChange"
        ></drop-down-new>
      </SettingsRow>

      <template v-if="!usesInProcessOpenVINO" #machine>
        <SettingsRow :label="languages.DEVICE">
          <DeviceSelector
            :backend="deviceSelectorBackend"
            :allowed-device-prefixes="deviceSelectorAllowedPrefixes"
          />
        </SettingsRow>
      </template>

      <template #reset-fallback>
        <WorkflowPresetResetButton />
      </template>

      <template
        v-if="currentPreset?.type === 'comfy' && currentPreset?.backend === 'comfyui'"
        #after
      >
        <div class="max-w-md mx-auto flex items-center gap-2">
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
      </template>
    </SettingsTabLayout>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  backendToService,
  useImageGenerationPresets,
} from '@/assets/js/store/imageGenerationPresets'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useI18N } from '@/assets/js/store/i18n'
import { usePresets } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import DeviceSelector from '@/components/DeviceSelector.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import PresetSelector from '@/components/PresetSelector.vue'
import SettingsRow from '@/components/SettingsRow.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import WorkflowPresetResetButton from '@/components/WorkflowPresetResetButton.vue'
import { useWorkflowDevices } from '@/assets/js/workflowDevices'
import * as toast from '@/assets/js/toast'

defineProps<{
  categories: string[]
}>()

const imageGeneration = useImageGenerationPresets()
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const backendServices = useBackendServices()
const languages = useI18N().state
const { currentPreset, presetRequiresOvms, usesInProcessOpenVINO, openvinoImageGenDevicePrefixes } =
  useWorkflowDevices()

const BACKEND_DISPLAY_NAME: Record<string, string> = {
  comfyui: 'ComfyUI',
  openvino: 'OpenVINO',
}
// The service whose running state drives the dropdown's green/grey dot.
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

const deviceSelectorBackend = computed<BackendServiceName>(() =>
  presetRequiresOvms.value ? 'openvino-backend' : backendToService[imageGeneration.backend],
)

// ComfyUI's native CPU/CUDA/XPU naming is unrelated to OpenVINO hardware support.
const deviceSelectorAllowedPrefixes = computed<string[] | undefined>(() =>
  deviceSelectorBackend.value === 'openvino-backend'
    ? openvinoImageGenDevicePrefixes.value
    : undefined,
)

async function handlePresetChange(presetName: string) {
  await presetSwitching.switchPreset(presetName, { skipModeSwitch: true })
}

async function handleVariantChange(presetName: string, variantName: string | null) {
  if (variantName) {
    await presetSwitching.switchPreset(presetName, { variant: variantName, skipModeSwitch: true })
  }
}

function isBackendServiceRunning(backend: string): boolean {
  const serviceName = BACKEND_TO_SERVICE[backend]
  if (!serviceName) return true
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
    if (backend === 'comfyui') return true
    // Keeps in-process OpenVINO variants (no `requiresService`) while hiding OVMS-only ones
    // on machines without openvino-backend.
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
  await presetSwitching.switchPreset(name, { variant: variantName, skipModeSwitch: true })
}

// A variant whose backend has since gone (e.g. openvino-backend uninstalled) would hide the
// Backend dropdown and leave the preset stuck on it, so fall back to the first allowed backend.
watch(
  [() => presetsStore.activePresetName, presetBackends, activeBackend],
  async ([name, allowed, current]) => {
    if (!name || allowed.length === 0) return
    if (allowed.includes(current)) return
    const fallbackVariant = presetsStore.pickInitialVariantForBackend(name, allowed[0])
    if (!fallbackVariant) return
    await presetSwitching.switchPreset(name, { variant: fallbackVariant, skipModeSwitch: true })
  },
  { immediate: true },
)
</script>
