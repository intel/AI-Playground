import { defineStore } from "pinia";

export const useI18N = defineStore("i18n", () => {
  const langName = ref("en_US");
  const state = reactive<StringKV>({
  });

  async function init() {
    const language = localStorage.getItem("language");
    if (language == "zh_CN" || language == "en_US") {
      await switchLanguage(language);
    } else {
      await initFromLocal();
    }
  }

  function initFromLocal() {
    return switchLanguage("en_US");
    return switchLanguage(navigator.language == "zh-CN" ? "zh_CN" : "en_US");
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
    localStorage.setItem("language", lang);
  }

  return {
    state,
    langName,
    init,
    switchLanguage,
  };
});