<script setup lang="ts">
// The two heading levels a settings sidebar has below its title (the sidebar's own
// `text-lg` h2 lives in SideModalBase): a section that groups rows, and a
// sub-heading inside one. Both are `text-sm`, and only the weight separates them
// from a row label — a sidebar this dense can't afford a third type size, but it
// does need headings that don't read as just another label. They were a mix of
// bare `<p>` (16px/400), `<h3>` and `<h4>` before, which is why this exists.
withDefaults(defineProps<{ sub?: boolean }>(), { sub: false })
</script>

<template>
  <component :is="sub ? 'h4' : 'h3'" class="text-sm" :class="sub ? 'font-medium' : 'font-semibold'">
    <slot />
  </component>
</template>
