<template>
  <div class="flex flex-col gap-4">
    <!-- Controls Row -->
    <div class="flex items-center gap-4 flex-wrap">
      <!-- Device Selector -->
      <div class="flex items-center gap-2 flex-1">
        <span class="text-sm text-muted-foreground whitespace-nowrap">Camera:</span>
        <DropDownNew
          class="flex-1"
          :items="deviceItems"
          :value="cameraStore.selectedDeviceId || ''"
          :on-change="onDeviceChange"
          :disabled="cameraStore.isLoading"
        />
      </div>

      <!-- Next Camera Button -->
      <Button
        variant="outline"
        size="sm"
        class="ml-auto"
        :disabled="cameraStore.isLoading"
        @click="cameraStore.selectNextDevice()"
      >
        Next Camera
      </Button>
    </div>

    <!-- Error Message -->
    <div
      v-if="cameraStore.error"
      class="flex items-center justify-between bg-destructive/10 border border-destructive/30 rounded-md px-4 py-2"
    >
      <span class="text-sm text-destructive">{{ cameraStore.error }}</span>
      <Button variant="ghost" size="sm" @click="cameraStore.clearError"> Dismiss </Button>
    </div>

    <!-- Camera View -->
    <div class="relative bg-card rounded-lg overflow-hidden border border-border">
      <!-- Video Stream -->
      <video
        ref="videoElement"
        autoplay
        playsinline
        class="w-full max-h-[400px] bg-black"
        :class="{ 'opacity-0': !cameraStore.isActive }"
      ></video>

      <!-- Placeholder -->
      <div
        v-if="!cameraStore.isActive"
        class="absolute inset-0 flex flex-col items-center justify-center bg-muted/50"
      >
        <VideoCameraIcon class="h-12 w-12 text-muted-foreground mb-2" />
        <span class="text-sm text-muted-foreground">
          {{ cameraStore.isLoading ? 'Starting Preview...' : 'Camera not active' }}
        </span>
      </div>
    </div>

    <!-- Capture Button -->
    <div class="flex justify-center">
      <Button variant="default" size="sm" :disabled="!cameraStore.isActive" @click="capture">
        Capture
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import DropDownNew from './DropDownNew.vue'
import { Button } from '@/components/ui/button'
import { useCameraStore } from '@/assets/js/store/camera'
import { VideoCameraIcon } from '@heroicons/vue/24/outline'

const cameraStore = useCameraStore()
const videoElement = ref<HTMLVideoElement | null>(null)

const emit = defineEmits<{
  capture: [file: File]
}>()

watch(
  () => cameraStore.stream,
  (newStream) => {
    if (videoElement.value && newStream) {
      videoElement.value.srcObject = newStream
    }
  },
)

onMounted(async () => {
  await cameraStore.getDevices()
  if (cameraStore.devices.length > 0) {
    const persistedId = cameraStore.devices.find(
      (d) => d.deviceId === cameraStore.selectedDeviceId,
    )?.deviceId
    const deviceId = persistedId ?? cameraStore.devices[0].deviceId
    await cameraStore.selectDevice(deviceId)
  }
})

onUnmounted(() => {
  cameraStore.stopCamera()
})

const deviceItems = computed(() =>
  cameraStore.devices.map((d) => ({
    label: d.label,
    value: d.deviceId,
    active: d.deviceId === cameraStore.selectedDeviceId,
  })),
)

async function onDeviceChange(deviceId: string) {
  await cameraStore.selectDevice(deviceId)
}

async function capture() {
  if (!videoElement.value) return
  const dataUrl = cameraStore.captureImage(videoElement.value)
  if (!dataUrl) return

  // Convert data URL to File
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  const file = new File([blob], 'camera-capture.png', { type: 'image/png' })

  emit('capture', file)
}
</script>
