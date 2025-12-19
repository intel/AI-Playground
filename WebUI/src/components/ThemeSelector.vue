<template>
  <drop-down-new
    :items="themeItems"
    :value="theme.active"
    @change="(value) => (theme.selected = value as Theme)"
  />
</template>

<script setup lang="ts">
import DropDownNew from '../components/DropDownNew.vue'
import { useTheme } from '@/assets/js/store/theme'

const theme = useTheme()

const themeToDisplayName = (themeName: Theme) => {
  switch (themeName) {
    case 'dark':
      return 'Default'
    case 'lnl':
      return 'Intel® Core™ Ultra'
    case 'bmg':
      return 'Intel® Arc™'
    case 'light':
      return 'Light'
    default:
      return themeName
  }
}

const themeItems = computed(() =>
  theme.availableThemes.map((t) => ({
    label: themeToDisplayName(t),
    value: t,
    active: true,
  })),
)
</script>
