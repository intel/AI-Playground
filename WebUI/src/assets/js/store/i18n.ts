import { defineStore } from "pinia";

export const useI18N = defineStore("i18n", () => {
  
  const langName = ref("en_US");
  const currentLanguageName = ref("English");
  const state = reactive<StringKV>({
  });

  async function init() {
    const language = localStorage.getItem("language");
    if (language == "zh_CN" || language == "en_US" || language == "ko_KR") {
      await switchLanguage(language);
    } else {
      await initFromLocal();
    }
  }

  function initFromLocal() {
    return switchLanguage("en_US");
    return switchLanguage(navigator.language == "zh-CN" ? "zh_CN" : "en_US");
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
 
  const languageOptions = ref([
    { value: 'en_US', name: state.SETTINGS_BASIC_LANGUAGE_EN },
    { value: 'zh_CN', name: state.SETTINGS_BASIC_LANGUAGE_ZH },
    { value: 'ko_KR', name: state.SETTINGS_BASIC_LANGUAGE_KO },
  ])

  const currentLanguageDict = ref<StringKV>({
    "en_US": state.SETTINGS_BASIC_LANGUAGE_EN,
    "zh_CN": state.SETTINGS_BASIC_LANGUAGE_ZH,
    "ko_KR": state.SETTINGS_BASIC_LANGUAGE_KO,
  });

  async function updateLanguageNames(lang: string) {
    currentLanguageDict.value["en_US"] = state.SETTINGS_BASIC_LANGUAGE_EN;
    currentLanguageDict.value["zh_CN"] = state.SETTINGS_BASIC_LANGUAGE_ZH;
    currentLanguageDict.value["ko_KR"] = state.SETTINGS_BASIC_LANGUAGE_KO;
    currentLanguageName.value = currentLanguageDict.value[lang];
    languageOptions.value = languageOptions.value.map((item) => {
      item.name = currentLanguageDict.value[item.value];
      return item;
    });
  }

  async function switchLanguage(lang: string) {
    const languageRecords = await import(`../../i18n/${lang}.json`);
    updateLanguageRecord(languageRecords);
    langName.value = lang;
    localStorage.setItem("language", lang);
    updateLanguageNames(lang);
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