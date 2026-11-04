import { computed, onMounted, ref } from 'vue'
import { usePresets, type Preset } from '@/assets/js/store/presets'

const DEFAULT_OV_IMAGE_GEN_DEVICES = ['CPU', 'GPU'] as const

function workflowUses(
  preset: Preset | null | undefined,
  matches: (classType: string) => boolean,
): boolean {
  if (!preset || preset.type !== 'comfy') return false
  return Object.values(preset.comfyUiApiWorkflow ?? {}).some((node) => {
    const classType = (node as { class_type?: unknown })?.class_type
    return typeof classType === 'string' && matches(classType)
  })
}

/** Which device the active workflow runs on: an OVMS service, a ComfyUI node, or ComfyUI itself. */
export function useWorkflowDevices() {
  const presetsStore = usePresets()

  // Variant-merged, so a swap to the OpenVINO variant is reflected at once.
  const currentPreset = computed(
    () => presetsStore.activePresetWithVariant ?? presetsStore.activePreset,
  )

  // OVMS-backed presets call the image API served by openvino-backend, so its device is the one to pick.
  const presetRequiresOvms = computed(() =>
    workflowUses(currentPreset.value, (classType) => classType.startsWith('OpenAICompatible')),
  )

  // The OpenVINO upscale variant runs in-process inside ComfyUI: its device is a workflow input.
  const usesInProcessOpenVINO = computed(() =>
    workflowUses(currentPreset.value, (classType) => classType === 'OpenVINOImageUpscale'),
  )

  // settings.json -> openvinoImageGenDevices, prefix-matched. NPU is left out by default because
  // RealESRGAN and SDXL exceed practical NPU memory budgets on most shipping hardware.
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

  return {
    currentPreset,
    presetRequiresOvms,
    usesInProcessOpenVINO,
    openvinoImageGenDevicePrefixes,
  }
}

export function deviceMatchesAllowedPrefixes(deviceId: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true
  const id = deviceId.toUpperCase()
  return prefixes.some((p) => {
    const upper = p.trim().toUpperCase()
    return upper.length > 0 && id.startsWith(upper)
  })
}
