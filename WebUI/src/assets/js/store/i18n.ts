import { defineStore } from "pinia";

export const useI18N = defineStore("i18n", () => {
  const langName = ref("en-US");
  const currentLanguageName = ref("English");
  const state = reactive<StringKV>({
  });

  // locale naming reference:
  // https://source.chromium.org/chromium/chromium/src/+/main:ui/base/l10n/l10n_util.cc
  const languageOptions = ref([
    { value: 'en-US', name: "English" },
    { value: 'zh-CN', name: "简体中文" },
    { value: 'ko', name: "영어" },
  ]);

  window.electronAPI.getLocalSettings().then((settings) => {
    if (settings.locale) {
      console.debug("system locale:", settings.locale);
      if (languageOptions.value.find((item) => item.value === settings.locale)) {
        langName.value = settings.locale;
      }
    }
  });

  async function init() {
    console.debug("init i18n:", langName.value);
    await switchLanguage(langName.value);
  }

  function changeLanguage(value: any, index: number) { 
    switchLanguage(value.value)
  } 

  function updateLanguageRecord(record: Record<string, string>) {
    Object.keys(record).forEach((key) => {
      state[key] = record[key];
    });
    document.title = state.MAIN_TITLE;
  }

  async function switchLanguage(lang: string) {
    const languageRecords = await import(`../../i18n/${lang}.json`);
    updateLanguageRecord(languageRecords);
    langName.value = lang;
    currentLanguageName.value = languageOptions.value.find((item) => item.value === lang)?.name || "Unknown";
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
