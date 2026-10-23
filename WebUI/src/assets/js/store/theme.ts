import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'

const knownThemes: Theme[] = ['dark', 'lnl', 'bmg', 'light']
// Matches what the shipped settings.json used to seed on first launch.
const defaultTheme: Theme = 'light'

export const useTheme = defineStore('theme', () => {
  const selected = ref<Theme | null>(null)

  // Step 8 (§6.1): the theme choice is a kernel-owned preference
  // (preferences.json), hydrated before mount and written through.
  const prefs = makeFileBackedPreference({
    section: 'theme',
    refs: { selected },
    legacyKey: 'theme',
  })
  if (import.meta.hot) import.meta.hot.dispose(() => prefs.dispose())

  return {
    selected,
    availableThemes: knownThemes,
    active: computed(() =>
      selected.value && knownThemes.includes(selected.value) ? selected.value : defaultTheme,
    ),
    init: () => prefs.init(),
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTheme, import.meta.hot))
}
