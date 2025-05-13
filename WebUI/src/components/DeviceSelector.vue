<template>
  <drop-down-new
    title="Inference Backend"
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
const selectedDevice = computed(() => devices.value.find((d) => d.selected) ?? devices.value[0])
const items = computed(() => devices.value.map(deviceToItem))
const deviceToItem = (d: InferenceDevice) => ({ label: d.name, value: d.id, active: true })
</script>
