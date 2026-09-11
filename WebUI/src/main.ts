import { createApp } from 'vue'
import App from './App.vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { preserveStateAcrossHmr } from './assets/js/piniaHmrStatePreservation'
import { useI18N } from './assets/js/store/i18n'
import { useErrors } from './assets/js/store/errors'
import { usePromptStore } from './assets/js/store/promptArea'
import { initLaminarTelemetry } from './lib/laminarTelemetry'
import { initDebugSettings } from './assets/js/store/debugSettings'

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

const i18n = useI18N()
i18n.init().then(() => {
  const languages = i18n.state
  app.config.globalProperties.languages = languages
  app.provide('languages', languages)
  app.mount('#app')
})
