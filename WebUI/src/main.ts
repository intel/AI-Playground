import { createApp } from 'vue'
import App from './App.vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { preserveStateAcrossHmr } from './assets/js/piniaHmrStatePreservation'
import { useI18N } from './assets/js/store/i18n'
import { useErrors } from './assets/js/store/errors'
import { usePromptStore } from './assets/js/store/promptArea'
import { useConversations } from './assets/js/store/conversations'
import { useAgentMode } from './assets/js/store/agentMode'
import { useImageGenerationPresets } from './assets/js/store/imageGenerationPresets'
import { useTheme } from './assets/js/store/theme'
import { useDeveloperSettings } from './assets/js/store/developerSettings'
import { useModelPreferences } from './assets/js/store/modelPreferences'
import { useTextToSpeech } from './assets/js/store/textToSpeech'
import { useQwen3TextToSpeech } from './assets/js/store/qwen3TextToSpeech'
import { useTextInference } from './assets/js/store/textInference'
import { usePresets } from './assets/js/store/presets'
import { useBackendServices } from './assets/js/store/backendServices'
import { initLaminarTelemetry } from './lib/laminarTelemetry'
import { initDebugSettings } from './assets/js/store/debugSettings'
import { startMediaRequestBridge } from './assets/js/artifact/mediaRequestBridge'
import { startChatAskBridge } from './assets/js/chat/chatAskBridge'
import { startPermissionsAdapter } from './assets/js/permissions/permissionsAdapter'
import { usePermissionGrants } from './assets/js/store/permissionGrants'
import { startQueueActivityProjection } from './lib/queueActivityProjection'
import { startKernelLedgerProjection } from './lib/kernelLedgerProjection'

const [settings, initialPage] = await Promise.all([
  window.electronAPI.getDemoModeSettings(),
  window.electronAPI.getInitialPage(),
  // Before the first inference: AI SDK 7 takes its telemetry integration once,
  // and a call made earlier would go untraced.
  initLaminarTelemetry(),
  // Before the first preset list is built: it decides whether the dev-only test
  // model and dummy workflows are in it.
  initDebugSettings(),
])
window.__AIPG_DEMO_MODE__ = settings.isDemoModeEnabled

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)
pinia.use(preserveStateAcrossHmr)
app.use(pinia)

// Global capture: route Vue render/lifecycle errors and uncaught async rejections
// into the central error sink so nothing fails silently. Deliberate per-path
// reporting still drives the primary UX; this is the safety net.
const errors = useErrors()
app.config.errorHandler = (err, _instance, info) => {
  errors.report(err, {
    code: 'vue/component-error',
    severity: 'error',
    technicalMessage: `Vue error in ${info}`,
  })
}
window.addEventListener('unhandledrejection', (event) => {
  errors.report(event.reason, { code: 'global/unhandled-rejection', severity: 'error' })
})
window.addEventListener('error', (event) => {
  errors.report(event.error ?? event.message, {
    code: 'global/uncaught-error',
    severity: 'error',
  })
})

if (initialPage !== null) {
  usePromptStore().setCurrentMode(initialPage)
} else {
  // No configured landing page: open on whichever mode the persisted active
  // preset belongs to (the preset persists across restarts, the mode doesn't).
  usePromptStore().alignModeToActivePreset()
}

// The main-process artifact runner asks the renderer for model checks
// over this bridge. Download consent goes through the permissions adapter.
startMediaRequestBridge()
// Chat tools run in main and ask this side by name for the few things that are
// genuinely the window's: the speech engine (and its download prompt),
// Chromium's audio decoder, and the Home Agent confirmation card.
startChatAskBridge()
startPermissionsAdapter()

// Hydrate the conversation threads from the kernel's files (step 8) before
// anything mounts, so the history panel and a resumed chat turn never see a
// half-hydrated map. This is also where the one-shot localStorage migration
// runs on a legacy boot.
await useConversations().init()

// Same for agent-session records (step 8): the Sessions panel and a resumed
// agent turn read a fully hydrated map. Instantiating the store here is safe —
// its setup only wires IPC and chat transport, no backend work.
await useAgentMode().init()

// Same for the generated-media gallery (step 8): the history strip hydrates
// from the record files under media/records/, and the one-shot localStorage
// upload runs on a legacy boot.
await useImageGenerationPresets().init()

// User preferences moved out of localStorage (step 8, §6.1): theme, dev
// toggles, model favorites and the TTS voice stores hydrate from the
// kernel's preferences.json — in parallel, since each section is
// independent — before anything mounts, so the theme applies on first paint
// and no consumer sees a pre-hydration default. The per-preset settings
// (textInference, presets variant picks) ride the same file; they init
// alongside their stores' rename migrations, after the imageGeneration
// store's own init has consumed its half of the shared legacy key. The
// backendServices launch flags hydrate from settings.json the same way, so
// any service start already sees the machine's flags.
await Promise.all([
  useTheme().init(),
  useDeveloperSettings().init(),
  useModelPreferences().init(),
  useTextToSpeech().init(),
  useQwen3TextToSpeech().init(),
  useTextInference().init(),
  usePresets().init(),
  useBackendServices().init(),
  usePermissionGrants().init(),
])

// Relabel a parked chat tool's activity with its queue position (the
// orchestrator's queue events, step 7). Ledger events (activity / error /
// stored) project onto the renderer sinks (step 14).
startQueueActivityProjection()
startKernelLedgerProjection()

const i18n = useI18N()
i18n.init().then(() => {
  const languages = i18n.state
  app.config.globalProperties.languages = languages
  app.provide('languages', languages)
  app.mount('#app')
})
