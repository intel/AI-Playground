<template>
  <drop-selector
    :array="themeOptions"
    @change="changeTheme"
  >
    <template #selected>
      <div class="flex gap-2 items-center">
        <span class="rounded-full bg-green-500 w-2 h-2"></span>
        <span>{{ activeThemeDisplayName }}</span>
      </div>
    </template>

    <template #list="slotItem">
      <div class="flex gap-2 items-center">
        <span class="rounded-full bg-green-500 w-2 h-2"></span>
        <span>{{ themeToDisplayName(slotItem.item.name) }}</span>
      </div>
    </template>
  </drop-selector>
</template>

<script setup lang="ts">
import DropSelector from '../components/DropSelector.vue'
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
    default:
      return themeName
  }
}

const themeOptions = computed(() =>
  theme.availableThemes.map((t) => ({
    name: themeToDisplayName(t),
    value: t,
  })),
)

const activeThemeDisplayName = computed(() => themeToDisplayName(theme.active))

function changeTheme(selectedOption: { name: string; value: Theme }) {
  theme.selected = selectedOption.value
}
</script>
