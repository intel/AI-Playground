<template>
  <drop-down-new
    :title="languages.SETTINGS_INFERENCE_DEVICE"
    @change="selectInferenceDevice"
    :value="selectedDevice?.id"
    :items="items"
  ></drop-down-new>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import DropDownNew from './DropDownNew.vue'
import { useBackendServices } from '@/assets/js/store/backendServices'

const props = defineProps<{
  backend: BackendServiceName
  allowedDevicePrefixes?: string[]
}>()

const selectInferenceDevice = async (item: string) => {
  await backendServices.selectDevice(props.backend, item)
  await backendServices.stopService(props.backend)
  await backendServices.startService(props.backend)
}
const backendServices = useBackendServices()
const devices = computed(
  () => backendServices?.info?.find((bs) => bs.serviceName === props.backend)?.devices ?? [],
)
const visibleDevices = computed(() => {
  const prefixes = props.allowedDevicePrefixes
  if (!prefixes || prefixes.length === 0) return devices.value
  const upper = prefixes.map((p) => p.trim().toUpperCase()).filter(Boolean)
  if (upper.length === 0) return devices.value
  return devices.value.filter((d) => upper.some((p) => d.id.toUpperCase().startsWith(p)))
})
// `selectedDevice` reads from the unfiltered device list so the dropdown's
// value reflects the backend's actual selection even if that device has been
// filtered out -- avoids silently lying about which device is in use. Items
// shown to the user are still restricted to `visibleDevices`.
const selectedDevice = computed(
  () => devices.value.find((d) => d.selected) ?? visibleDevices.value[0],
)
const items = computed(() => visibleDevices.value.map(deviceToItem))
const deviceToItem = (d: InferenceDevice) => ({
  label: `${d.id}: ${d.name}`,
  value: d.id,
  active: true,
})
</script>
