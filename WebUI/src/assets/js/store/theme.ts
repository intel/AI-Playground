import { defineStore } from 'pinia'

const knownThemes: Theme[] = ['dark', 'lnl', 'bmg', 'light']
export const useTheme = defineStore(
  'theme',
  () => {
    const selected = ref<Theme | null>(null)
    const availableThemes = ref<Theme[]>([...knownThemes])

    window.electronAPI.getThemeSettings().then((themeSettings) => {
      const themesFromSettings = themeSettings.availableThemes.filter((t) =>
        knownThemes.includes(t),
      )
      if (themesFromSettings.length > 0) {
        availableThemes.value = themesFromSettings
      }
      if (!selected.value && knownThemes.includes(themeSettings.currentTheme)) {
        selected.value = themeSettings.currentTheme
      }
    })

    return {
      selected,
      availableThemes,
      active: computed(() =>
        selected.value && availableThemes.value.includes(selected.value)
          ? selected.value
          : availableThemes.value[0],
      ),
    }
  },
  {
    persist: {
      pick: ['selected'],
    },
  },
)
