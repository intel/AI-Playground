import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { useDebugSettings } from '@/assets/js/store/debugSettings'
import { isAcerVendorOverride } from '@/lib/acerVendorOverride'

const POLL_MS = 3000

export const useAcerPhoneWebcam = defineStore('acerPhoneWebcam', () => {
  const debugSettings = useDebugSettings()
  const directActive = ref(false)
  let subscribers = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function refresh() {
    if (!isAcerVendorOverride(debugSettings.oemVendorOverride)) {
      directActive.value = false
      return
    }
    directActive.value = await window.electronAPI.cameraCapture.isDirectRunning()
  }

  async function startPollingIfNeeded() {
    if (pollTimer) return
    if (!isAcerVendorOverride(debugSettings.oemVendorOverride)) return
    const platform = await window.electronAPI.getPlatform()
    if (platform !== 'win32') return
    await refresh()
    pollTimer = setInterval(() => {
      void refresh()
    }, POLL_MS)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    directActive.value = false
  }

  function acquire() {
    subscribers += 1
    if (subscribers === 1) void startPollingIfNeeded()
  }

  function release() {
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0) stopPolling()
  }

  return {
    directActive,
    acquire,
    release,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAcerPhoneWebcam, import.meta.hot))
}
