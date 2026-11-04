<template>
  <div class="flex flex-col gap-6 p-4 w-full max-w-3xl mx-auto">
    <slot name="picker" />
    <p
      v-if="readOnly && readOnlyNote"
      :id="readOnlyNoteId"
      class="text-xs text-muted-foreground rounded-sm ring-1 ring-border px-2 py-1"
    >
      {{ readOnlyNote }}
    </p>
    <!-- A fieldset, so every control below (Reka triggers are buttons too) is disabled natively. -->
    <fieldset
      :disabled="readOnly"
      :aria-describedby="readOnly && readOnlyNote ? readOnlyNoteId : undefined"
      class="flex flex-col gap-6 min-w-0 m-0 p-0 border-0"
    >
      <template v-if="!machineOnly">
        <div v-if="$slots.default" class="flex flex-col gap-4">
          <slot />
        </div>
        <SessionSettingsActions @reset="emit('reset')">
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
    </fieldset>
    <slot name="after" />
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import MachineSettingsGroup from '@/components/MachineSettingsGroup.vue'
import SessionSettingsActions from '@/components/SessionSettingsActions.vue'

defineProps<{
  /** Every setting in the tab applies to all sessions (the Home Agent preset, speech engines). */
  machineOnly?: boolean
  machineNote?: string
  /** Locks everything below the picker, e.g. while an Agent Run holds the Session. */
  readOnly?: boolean
  readOnlyNote?: string
}>()

const emit = defineEmits<{
  /** "Reset to default" restored the Session's copy of the preset. */
  reset: []
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

const readOnlyNoteId = useId()
</script>
