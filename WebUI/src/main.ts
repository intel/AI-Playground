import { createApp } from 'vue'
import App from './App.vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { useI18N } from './assets/js/store/i18n'
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
