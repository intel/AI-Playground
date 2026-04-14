import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { applyDemoModeExplicitDefaults } from './demoModeDefaults'

export type DemoButtonId =
  | 'mode-button-chat'
  | 'mode-button-imageGen'
  | 'mode-button-imageEdit'
  | 'mode-button-video'
  | 'camera-button'
  | 'microphone-button'
  | 'app-settings-button'
  | 'advanced-settings-button'
  | 'plus-icon'

export const FALLBACK_NOTIFICATION_DOT_BUTTONS: DemoButtonId[] = [
  'mode-button-chat',
  'mode-button-imageGen',
  'mode-button-imageEdit',
  'camera-button',
  'microphone-button',
  'app-settings-button',
  'advanced-settings-button',
  'plus-icon',
]

const FALLBACK_ENABLED_MODES: ModeType[] = ['chat', 'imageGen', 'imageEdit', 'video']

function createInitialVisitedState(
  notificationDotButtons: DemoButtonId[],
  enabledModes: ModeType[],
): Record<DemoButtonId, boolean> {
  const state = Object.fromEntries(notificationDotButtons.map((id) => [id, false])) as Record<
    DemoButtonId,
    boolean
  >
  const modeButtonPrefix = 'mode-button-'
  for (const id of notificationDotButtons) {
    if (id.startsWith(modeButtonPrefix)) {
      const mode = id.slice(modeButtonPrefix.length) as ModeType
      if (!enabledModes.includes(mode)) {
        state[id] = true
      }
    }
  }
  return state
}

type ExplicitDefaultsState = 'idle' | 'applying' | 'applied'

type DriverJsComponent = {
  triggerFirstTimeHelp: (buttonId: DemoButtonId) => void
}

let driverJsRef: DriverJsComponent | null = null

export const useDemoMode = defineStore('demoMode', () => {
  // NOTE: Demo mode UI strings (tour text, sample prompts, dialog labels) are intentionally
  // English-only. Demo mode targets trade-show kiosks where English is the expected language.
  // Existing DEMO_* keys in en-US.json are legacy and unused by the current driver.js tour.
  const enabled = ref(false)
  const profile = ref<DemoProfile | null>(null)
  const explicitDefaultsState = ref<ExplicitDefaultsState>('idle')
  const visitedButtons = ref<Record<DemoButtonId, boolean>>(
    createInitialVisitedState(FALLBACK_NOTIFICATION_DOT_BUTTONS, FALLBACK_ENABLED_MODES),
  )
  const showResetDialog = ref(false)

  const notificationDotButtonIds = computed<DemoButtonId[]>(
    () =>
      (profile.value?.notificationDotButtons as DemoButtonId[]) ??
      FALLBACK_NOTIFICATION_DOT_BUTTONS,
  )

  function markAsVisited(buttonId: DemoButtonId) {
    visitedButtons.value[buttonId] = true
  }

  function isVisited(buttonId: DemoButtonId): boolean {
    return visitedButtons.value[buttonId]
  }

  function registerDriverJs(ref: DriverJsComponent) {
    driverJsRef = ref
  }

  function triggerFirstTimeHelp(buttonId: DemoButtonId): boolean {
    if (!enabled.value) return false
    if (isVisited(buttonId)) return false
    markAsVisited(buttonId)
    driverJsRef?.triggerFirstTimeHelp(buttonId)
    return true
  }

  // --- User activity detection ---

  let resetTimer: null | ReturnType<typeof setTimeout> = null
  let trackUserInteractionInterval: null | ReturnType<typeof setInterval> = null
  // Sticky user activation (navigator.userActivation.hasBeenActive) is not reset by location.reload()
  // in Chromium/Electron — it is tied to the Window and never clears. Track interaction since this
  // page load ourselves so the reset timer only starts after a real user gesture post-reload.
  let userInteractedThisLoad = false

  const USER_IDLE_THRESHOLD_MS = 5000
  let lastMouseMove = 0
  const onMouseMove = () => {
    lastMouseMove = Date.now()
  }
  function isUserActive(): boolean {
    return navigator.userActivation.isActive || Date.now() - lastMouseMove < USER_IDLE_THRESHOLD_MS
  }

  const resetInSeconds = ref<null | number>(null)
  const passcode = ref('')
  const hasPasscode = computed(() => passcode.value.length > 0)

  function applyDemoSettingsPayload(res: DemoModeSettings) {
    enabled.value = res.isDemoModeEnabled
    profile.value = res.profile ?? null
    resetInSeconds.value = res.demoModeResetInSeconds
    passcode.value = res.demoModePasscode ?? ''

    const dotButtons =
      (profile.value?.notificationDotButtons as DemoButtonId[]) ?? FALLBACK_NOTIFICATION_DOT_BUTTONS
    const enabledModes = profile.value?.enabledModes ?? FALLBACK_ENABLED_MODES
    visitedButtons.value = createInitialVisitedState(dotButtons, enabledModes)
  }

  async function refreshFromMainConfig() {
    const res = await window.electronAPI.getDemoModeSettings()
    applyDemoSettingsPayload(res)
  }

  window.electronAPI.getDemoModeSettings().then((res) => {
    applyDemoSettingsPayload(res)

    if (res.isDemoModeEnabled && res.demoModeResetInSeconds) {
      const markInteracted = (e: Event) => {
        if (e.isTrusted) userInteractedThisLoad = true
      }
      // Delay attaching listeners so load/focus spurious events don't start the reset timer
      const GRACE_MS = 1000
      window.setTimeout(() => {
        window.addEventListener('click', markInteracted, { capture: true, once: true })
        window.addEventListener('keydown', markInteracted, { capture: true, once: true })
        window.addEventListener('mousemove', onMouseMove)
      }, GRACE_MS)
      trackUserInteraction()
    }
  })

  const showDemoToggle = computed(() => hasPasscode.value)

  function stopActivityTracking() {
    if (trackUserInteractionInterval) {
      clearInterval(trackUserInteractionInterval)
      trackUserInteractionInterval = null
    }
    if (resetTimer) {
      clearTimeout(resetTimer)
      resetTimer = null
    }
    window.removeEventListener('mousemove', onMouseMove)
  }

  function resetDemo() {
    stopActivityTracking()
    sessionStorage.clear()
    location.reload()
  }

  const trackUserInteraction = () => {
    if (trackUserInteractionInterval) {
      clearInterval(trackUserInteractionInterval)
      trackUserInteractionInterval = null
    }
    trackUserInteractionInterval = setInterval(() => {
      if (!userInteractedThisLoad) return
      if (isUserActive()) {
        if (resetTimer) {
          clearTimeout(resetTimer)
          resetTimer = null
        }
      } else {
        if (!resetTimer && resetInSeconds.value && !showResetDialog.value) {
          resetTimer = setTimeout(() => {
            resetTimer = null
            showResetDialog.value = true
          }, resetInSeconds.value * 1000)
        }
      }
    }, 1000)
  }

  function cancelReset() {
    showResetDialog.value = false
  }

  async function applyExplicitDefaults() {
    if (!enabled.value || explicitDefaultsState.value !== 'idle') return

    explicitDefaultsState.value = 'applying'
    try {
      // Brief delay so dependent stores (presets, models) finish their own async initialisation
      // after the app reaches "running" state before we override their values.
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await applyDemoModeExplicitDefaults()
    } finally {
      explicitDefaultsState.value = 'applied'
    }
  }

  function verifyPasscode(input: string): boolean {
    return input === passcode.value
  }

  async function setEnabled(value: boolean) {
    try {
      const result = await window.electronAPI.updateLocalSettings({ isDemoModeEnabled: value })
      if (result.success) {
        enabled.value = value
        setTimeout(() => location.reload(), 1000)
      } else {
        console.error('Failed to update demo mode setting')
      }
    } catch (error) {
      console.error('Failed to toggle demo mode:', error)
    }
  }

  return {
    enabled,
    profile,
    notificationDotButtonIds,
    showDemoToggle,
    showResetDialog,
    isVisited,
    registerDriverJs,
    triggerFirstTimeHelp,
    applyExplicitDefaults,
    verifyPasscode,
    setEnabled,
    cancelReset,
    resetDemo,
    refreshFromMainConfig,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDemoMode, import.meta.hot))
}
