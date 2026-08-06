<script setup lang="ts">
// Shared settings-gear dropdown used by every backend/component row (regular
// backends, Phison aiDAPTIV+, Cloud Mode). It bundles the gear button trigger
// together with the DropdownMenu shell (label + separator) so the icon, menu
// styling, and open/close behavior stay identical everywhere. Callers only
// provide the label, optional title/disabled state, and the menu items via the
// default slot. Bind `v-model:open` to close the menu programmatically after an
// action (e.g. once a dialog is opened or a reinstall completes).
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import SettingsButton from '@/components/SettingsButton.vue'

defineProps<{
  label: string
  title?: string
  disabled?: boolean
}>()

const open = defineModel<boolean>('open', { default: false })
</script>

<template>
  <DropdownMenu v-model:open="open">
    <DropdownMenuTrigger as-child>
      <SettingsButton :title="title" :disabled="disabled" />
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuLabel>{{ label }}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <slot />
    </DropdownMenuContent>
  </DropdownMenu>
</template>
