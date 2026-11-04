<template>
  <div class="flex flex-col gap-6 p-4 w-full max-w-3xl mx-auto">
    <slot name="picker" />
    <template v-if="!machineOnly">
      <div v-if="$slots.default" class="flex flex-col gap-4">
        <slot />
      </div>
      <SessionSettingsActions>
        <slot name="reset-fallback" />
      </SessionSettingsActions>
      <MachineSettingsGroup v-if="$slots.machine" :note="machineNote">
        <slot name="machine" />
      </MachineSettingsGroup>
    </template>
    <!-- Nothing here is the Session's, so the default buttons have nothing to act on. -->
    <MachineSettingsGroup v-else :note="machineNote">
      <slot />
      <slot name="machine" />
      <slot name="reset-fallback" />
    </MachineSettingsGroup>
    <slot name="after" />
  </div>
</template>

<script setup lang="ts">
import MachineSettingsGroup from '@/components/MachineSettingsGroup.vue'
import SessionSettingsActions from '@/components/SessionSettingsActions.vue'

defineProps<{
  /** Every setting in the tab applies to all sessions (the Home Agent preset, speech engines). */
  machineOnly?: boolean
  machineNote?: string
}>()

defineSlots<{
  /** The full preset picker, on top of Inferencing. */
  picker?: () => unknown
  /** The preset's Session Settings. */
  default?: () => unknown
  /** Machine Settings, shown in the "Applies to all sessions" group. */
  machine?: () => unknown
  /** Reset control for a preset the Session does not hold. */
  'reset-fallback'?: () => unknown
  /** Panels that open below the settings, e.g. the document uploader. */
  after?: () => unknown
}>()
</script>
