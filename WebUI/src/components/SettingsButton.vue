<script setup lang="ts">
// Shared settings (gear) button so every backend/component row renders the icon
// with the same size, color, and disabled styling by default. Attributes such as
// `title`, `disabled`, and click handlers fall through to the underlying button,
// and it can be used as a `DropdownMenuTrigger` via `as-child`.
import { Cog6ToothIcon } from '@heroicons/vue/24/solid'
</script>

<template>
  <button
    type="button"
    class="text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
  >
    <Cog6ToothIcon class="size-6" />
  </button>
</template>
