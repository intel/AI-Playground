<script setup lang="ts">
// One row of a settings sidebar: a fixed label column and a control filling the
// rest. A component rather than a copied class string because that string is what
// drifted — a row that spelled its label as a raw <label> rendered it 16px/400
// beside its neighbours' 14px/500, and rows whose control is short (a checkbox, a
// slider) collapsed below the 30px every picker is tall. Pass `role`/`aria-label`
// (or any attribute) straight through: they land on the row element.
import { Label } from '@/components/ui/label'

withDefaults(
  defineProps<{
    /** The row's label. Use the `label` slot instead when it needs more than text. */
    label?: string
    /** Id of the control the label belongs to, so clicking the label reaches it. */
    labelFor?: string
    /** Top-align a row whose control is taller than one line (e.g. a textarea). */
    align?: 'center' | 'start'
  }>(),
  { align: 'center' },
)
</script>

<template>
  <div
    class="grid min-h-[30px] grid-cols-[120px_1fr] gap-4"
    :class="align === 'start' ? 'items-start' : 'items-center'"
  >
    <slot name="label">
      <Label :for="labelFor" class="whitespace-nowrap">{{ label }}</Label>
    </slot>
    <slot />
  </div>
</template>
