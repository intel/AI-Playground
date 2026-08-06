<!--
  Selectable card used in the left-hand column of the setup wizard pages
  (Home Agent channels, Cloud Mode providers). Owns the shared card shell —
  border, rounding, hover, and the selected primary highlight — so the two
  pages can't drift apart. Content is provided via the default slot.
-->
<template>
  <div
    class="flex flex-col gap-2 p-3 rounded-lg border cursor-pointer transition-colors"
    :class="selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'"
    @click="emit('select')"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{ selected: boolean }>()
const emit = defineEmits<{ select: [] }>()
</script>
