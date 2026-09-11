import { defineStore } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'

const knownThemes: Theme[] = ['dark', 'lnl', 'bmg', 'light']
// Matches what the shipped settings.json used to seed on first launch.
const defaultTheme: Theme = 'light'

export const useTheme = defineStore(
  'theme',
  () => {
    const selected = ref<Theme | null>(null)

    return {
      selected,
      availableThemes: knownThemes,
      active: computed(() =>
        selected.value && knownThemes.includes(selected.value) ? selected.value : defaultTheme,
      ),
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['selected'],
    },
  },
)
