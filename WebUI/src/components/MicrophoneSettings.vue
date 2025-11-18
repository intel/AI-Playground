<template>
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.MICROPHONE }}</Label>
      <drop-down-new
        :title="languages.MICROPHONE"
        @change="onSelect"
        :value="selectedDeviceId"
        :items="items"
      ></drop-down-new>
    </div>

    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.SETTINGS_AUDIO_SILENCE_DETECTION }}</Label>
      <Checkbox
        id="silence-detection"
        :checked="audioRecorder.config.enableSilenceDetection"
        @click="toggleSilenceDetection()"
      />
    </div>

    <div
      v-if="audioRecorder.config.enableSilenceDetection"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">{{ languages.SETTINGS_AUDIO_SILENCE_DURATION }}</Label>
      <input
        type="number"
        :value="audioRecorder.config.silenceDuration"
        @input="updateSilenceDuration"
        min="0.5"
        max="10"
        step="0.5"
        class="rounded-sm text-foreground text-center h-7 w-20 leading-7 p-0 bg-transparent border border-border"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, computed } from 'vue'
import DropDownNew from './DropDownNew.vue'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { useAudioRecorder } from "../assets/js/store/audioRecorder"
import { useI18N } from '@/assets/js/store/i18n.ts'

const audioRecorder = useAudioRecorder()
const { state: languages } = useI18N()

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

function toggleSilenceDetection() {
  audioRecorder.updateConfig({
    enableSilenceDetection: !audioRecorder.config.enableSilenceDetection
  })
}

function updateSilenceDuration(event: Event) {
  const target = event.target as HTMLInputElement
  const value = parseFloat(target.value)
  if (!isNaN(value)) {
    audioRecorder.updateConfig({ silenceDuration: value })
  }
}
</script>
