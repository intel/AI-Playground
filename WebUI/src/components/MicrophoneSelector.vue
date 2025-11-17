<template>
  <drop-down-new
    :title="title"
    @change="onSelect"
    :value="selectedDeviceId"
    :items="items"
  ></drop-down-new>
</template>

<script setup lang="ts">
import { onMounted, computed, ref } from 'vue'
import DropDownNew from './DropDownNew.vue'
import { useAudioRecorder } from "../assets/js/store/audioRecorder";

const props = defineProps<{
  title?: string
}>()

const audioRecorder = useAudioRecorder()

onMounted(async () => {
  await audioRecorder.loadAudioDevices()
})

const selectedDeviceId = computed(() => audioRecorder.selectedDeviceId ?? '')

const items = computed(() =>
  audioRecorder.audioDevices.map((d) => ({
    label: `${d.label || 'Unknown Mic'}`,
    value: d.deviceId,
    active: true,
  }))
)

async function onSelect(deviceId: string) {
  audioRecorder.updateSelectedDevice(deviceId)
}
</script>
