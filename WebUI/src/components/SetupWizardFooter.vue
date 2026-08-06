<!--
  Shared footer for the setup wizard pages: a left-aligned Back button and a
  right-aligned primary action, with an optional `actions` slot for secondary
  buttons (e.g. Cloud Mode's "Save"). Keeps the Back/primary button styling
  consistent across pages.
-->
<template>
  <div class="flex items-center justify-between pt-6">
    <button
      v-if="showBack"
      type="button"
      class="py-2 px-5 rounded text-sm font-medium border border-border hover:bg-muted transition-colors"
      @click="emit('back')"
    >
      ← Back
    </button>
    <span v-else />
    <div class="flex items-center gap-3">
      <slot name="actions" />
      <button
        type="button"
        class="bg-primary py-2 px-8 rounded text-primary-foreground text-sm font-medium disabled:opacity-50 transition-colors"
        :disabled="primaryDisabled"
        @click="emit('primary')"
      >
        {{ primaryLabel }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    showBack?: boolean
    primaryLabel?: string
    primaryDisabled?: boolean
  }>(),
  {
    showBack: true,
    primaryLabel: 'Done',
    primaryDisabled: false,
  },
)
const emit = defineEmits<{ back: []; primary: [] }>()
</script>
