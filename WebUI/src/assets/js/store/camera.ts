import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type CameraDevice = {
  deviceId: string
  label: string
  kind: string
}

export const useCameraStore = defineStore(
  'camera',
  () => {
    // State
    const devices = ref<CameraDevice[]>([])
    const selectedDeviceId = ref<string | null>(null)
    const stream = ref<MediaStream | null>(null)
    const error = ref<string | null>(null)
    const isLoading = ref(false)

    // Getters
    const isActive = computed(() => stream.value !== null)

    // Actions
    async function getDevices() {
      try {
        isLoading.value = true
        error.value = null

        // Request camera permission first
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: true })
        tempStream.getTracks().forEach((track) => track.stop())

        const mediaDevices = await navigator.mediaDevices.enumerateDevices()
        const videoDevices = mediaDevices.filter((device) => device.kind === 'videoinput')

        devices.value = videoDevices.map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
          kind: device.kind,
        }))
      } catch (err) {
        error.value = err instanceof Error ? err.message : 'Failed to get camera devices'
        console.error('Error getting camera devices:', err)
      } finally {
        isLoading.value = false
      }
    }

    async function startCamera() {
      const targetDeviceId = selectedDeviceId.value
      if (!targetDeviceId) {
        error.value = 'No camera device selected'
        return
      }

      try {
        isLoading.value = true
        error.value = null

        stream.value = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: targetDeviceId } },
        })
      } catch (err) {
        error.value = err instanceof Error ? err.message : 'Failed to start camera'
        console.error('Error starting camera:', err)
      } finally {
        isLoading.value = false
      }
    }

    function stopCamera() {
      if (stream.value) {
        stream.value.getTracks().forEach((track) => track.stop())
        stream.value = null
      }
    }

    async function selectDevice(deviceId: string) {
      stopCamera()
      selectedDeviceId.value = deviceId
      await startCamera()
    }

    async function selectNextDevice() {
      await getDevices()
      if (devices.value.length === 0) return
      const currentIndex = devices.value.findIndex((d) => d.deviceId === selectedDeviceId.value)
      const nextIndex = (currentIndex + 1) % devices.value.length
      await selectDevice(devices.value[nextIndex].deviceId)
    }

    function captureImage(video: HTMLVideoElement): string | null {
      if (!isActive.value) {
        error.value = 'Camera is not active'
        return null
      }

      if (video.videoWidth === 0 || video.videoHeight === 0) {
        error.value = 'Camera is not ready yet'
        return null
      }

      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        error.value = 'Failed to get canvas context'
        return null
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png')
    }

    function clearError() {
      error.value = null
    }

    return {
      devices,
      selectedDeviceId,
      stream,
      isActive,
      error,
      isLoading,
      getDevices,
      startCamera,
      stopCamera,
      captureImage,
      selectDevice,
      selectNextDevice,
      clearError,
    }
  },
  {
    persist: {
      pick: ['selectedDeviceId'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCameraStore, import.meta.hot))
}
