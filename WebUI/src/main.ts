import { createApp } from 'vue';
import App from './App.vue';
import { createPinia } from "pinia";
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { useI18N } from './assets/js/store/i18n';

const app = createApp(App);
app.use(createPinia());
const pinia = createPinia();
pinia.use(piniaPluginPersistedstate)
app.use(pinia);
const i18n = useI18N();
i18n.init().then(() => {
    const languages = i18n.state;
    app.config.globalProperties.languages = languages;
    app.provide('languages', languages);
    app.mount('#app');
});