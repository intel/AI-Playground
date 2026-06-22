import { createApp } from 'vue'
import App from './App.vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { useI18N } from './assets/js/store/i18n'
import { useErrors } from './assets/js/store/errors'
import { usePromptStore } from './assets/js/store/promptArea'

const [settings, initialPage] = await Promise.all([
  window.electronAPI.getDemoModeSettings(),
  window.electronAPI.getInitialPage(),
])
window.__AIPG_DEMO_MODE__ = settings.isDemoModeEnabled

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)
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
}

const i18n = useI18N()
i18n.init().then(() => {
  const languages = i18n.state
  app.config.globalProperties.languages = languages
  app.provide('languages', languages)
  app.mount('#app')
})
