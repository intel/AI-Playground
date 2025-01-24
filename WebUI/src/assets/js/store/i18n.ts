import { defineStore } from "pinia";

export const useI18N = defineStore("i18n", () => {
  const langName = ref("en-US");
  const currentLanguageName = ref("English");
  const state = reactive<StringKV>({
  });

  // locale naming reference:
  // https://source.chromium.org/chromium/chromium/src/+/main:ui/base/l10n/l10n_util.cc
  const languageOptions = ref([
    { value: 'de', name: "Deutsch" },
    { value: 'en-US', name: "English" },
    { value: 'es', name: "Español" },
    { value: 'id', name: "Bahasa Indonesia" },
    { value: 'it', name: "Italiano" },
    { value: 'ja', name: "日本語" },
    { value: 'ko', name: "영어" },
    { value: 'pl', name: "język polski" },
    { value: 'th', name: "ภาษาไทย" },
    { value: 'tr', name: "Türkçe" },
    { value: 'vi', name: "Tiếng Việt" },
    { value: 'zh-CN', name: "简体中文" },
    { value: 'zh-TW', name: "繁體中文" },
  ]);

  window.electronAPI.getLocalSettings().then((settings) => {
    const locale = settings.locale;
    console.debug("system locale:", locale);
    if (locale) {
      if (languageOptions.value.find((item) => item.value === locale)) { // use the locale directly if it's supported
        langName.value = locale;
      } else if (locale.includes('-')) { // fallback if the locale contains '-'
        const lang = locale.split('-')[0];
        langName.value = languageOptions.value.find((item) => item.value.includes(lang))?.value || 'en-US';
      } else { // fallback to en-US
        langName.value = 'en-US';
      }
    }
  });

  async function init() {
    const locale = localStorage.getItem("locale");
    if (locale) {
      langName.value = locale;
    }
    console.debug("init i18n:", langName.value);
    await switchLanguage(langName.value);
  }

  function changeLanguage(value: { value: string }, _index: number) { 
    switchLanguage(value.value)
  } 

  function updateLanguageRecord(record: Record<string, string>) {
    Object.keys(record).forEach((key) => {
      state[key] = record[key];
    });
    document.title = state.MAIN_TITLE;
  }

  async function switchLanguage(lang: string) {
    const [languageRecords, fallbackRecords] = await Promise.all([
      import(`../../i18n/${lang}.json`).catch(() => ({})),
      import(`../../i18n/en-US.json`)
    ]);

    const mergedRecords = { ...fallbackRecords, ...languageRecords };
    updateLanguageRecord(mergedRecords);
    langName.value = lang;
    currentLanguageName.value = languageOptions.value.find((item) => item.value === lang)?.name || "Unknown";

    localStorage.setItem("locale", lang);
  }

  return {
    state,
    langName,
    languageOptions,
    currentLanguageName,
    init,
    switchLanguage,
    changeLanguage,
  };

});
