import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export const useI18N = defineStore('i18n', () => {
  const langName = ref('en-US')
  const currentLanguageName = ref('English')
  const state = reactive<StringKV>({})

  // locale naming reference:
  // https://source.chromium.org/chromium/chromium/src/+/main:ui/base/l10n/l10n_util.cc
  const languageOptions = ref([
    { value: 'de', name: 'Deutsch' },
    { value: 'en-US', name: 'English' },
    { value: 'es', name: 'Español' },
    { value: 'id', name: 'Bahasa Indonesia' },
    { value: 'it', name: 'Italiano' },
    { value: 'ja', name: '日本語' },
    { value: 'ko', name: '영어' },
    { value: 'pl', name: 'język polski' },
    { value: 'th', name: 'ภาษาไทย' },
    { value: 'tr', name: 'Türkçe' },
    { value: 'vi', name: 'Tiếng Việt' },
    { value: 'zh-CN', name: '简体中文' },
    { value: 'zh-TW', name: '繁體中文' },
  ])

  async function init() {
    // Resolve the display language exactly once, in priority order:
    //   1. languageOverride from the app settings (explicit deployment choice)
    //   2. the user's stored choice (e.g. from the setup wizard)
    //   3. the OS locale reported by the main process
    //   4. en-US fallback
    // Previously a module-scope getLocaleSettings().then() raced with init():
    // when it resolved after init(), it overwrote the wizard's stored choice
    // with the OS locale, so the wizard selection never took effect.
    let languageOverride: string | null = null
    let osLocale = ''
    try {
      const settings = await window.electronAPI.getLocaleSettings()
      languageOverride = settings.languageOverride
      osLocale = settings.locale || ''
    } catch {
      console.debug('getLocaleSettings() failed, using stored/OS defaults')
    }

    if (languageOverride && languageOptions.value.some((l) => l.value === languageOverride)) {
      langName.value = languageOverride
    } else {
      const stored = localStorage.getItem('locale')
      if (stored && languageOptions.value.some((l) => l.value === stored)) {
        langName.value = stored
      } else if (osLocale) {
        if (languageOptions.value.find((item) => item.value === osLocale)) {
          // use the locale directly if it's supported
          langName.value = osLocale
        } else if (osLocale.includes('-')) {
          // fallback if the locale contains '-'
          const lang = osLocale.split('-')[0]
          langName.value =
            languageOptions.value.find((item) => item.value.includes(lang))?.value || 'en-US'
        } else {
          // fallback to en-US
          langName.value = 'en-US'
        }
      }
    }
    console.debug('init i18n:', langName.value)
    await switchLanguage(langName.value)
  }

  function changeLanguage(value: { value: string }, _index: number) {
    switchLanguage(value.value)
  }

  function updateLanguageRecord(record: Record<string, string>) {
    Object.keys(record).forEach((key) => {
      state[key] = record[key]
    })
    document.title = state.MAIN_TITLE
  }

  async function switchLanguage(lang: string) {
    const [languageRecords, fallbackRecords] = await Promise.all([
      import(`../../i18n/${lang}.json`).catch(() => ({})),
      import(`../../i18n/en-US.json`),
    ])

    const mergedRecords = { ...fallbackRecords, ...languageRecords }
    updateLanguageRecord(mergedRecords)
    langName.value = lang
    currentLanguageName.value =
      languageOptions.value.find((item) => item.value === lang)?.name || 'Unknown'

    localStorage.setItem('locale', lang)
  }

  return {
    state,
    langName,
    languageOptions,
    currentLanguageName,
    init,
    switchLanguage,
    changeLanguage,
  }
})
