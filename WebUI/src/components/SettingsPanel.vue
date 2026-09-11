<script setup lang="ts">
// A bordered settings section whose master switch sits in its own header: the
// toggle and what it governs are one block, which is one fewer label row than
// floating the switch above the panel. The two tool panels spelled this out
// separately — same border, same header, same disabled-with-a-reason treatment,
// two slightly different gaps and one heading each that could drift from the
// other. `disabledReason` greys the header and is spelled out underneath it — a
// title attribute alone reaches neither a keyboard user nor a touch one, and a
// switch that refuses to move with no visible explanation reads as a bug. The
// switch is dead while it is set.
import { computed } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

const props = defineProps<{
  /** Heading text, and the master switch's label — clicking it toggles the switch. */
  title: string
  /** Id of the master switch, so the heading can point at it. */
  switchId: string
  /** Omit for a section governed elsewhere (an agent capability), leaving the frame only. */
  enabled?: boolean
  /** Why the switch can't be used, when it can't (e.g. the model has no tool calling). */
  disabledReason?: string
}>()

const emit = defineEmits<{ (e: 'update:enabled', value: boolean): void }>()

// Derived from `switchId`, which is already unique per panel, so two panels on one
// screen can't both claim the same description id.
const reasonId = computed(() => `${props.switchId}-disabled-reason`)

function toggle() {
  if (props.disabledReason) return
  emit('update:enabled', !props.enabled)
}
</script>

<template>
  <div class="flex flex-col gap-3 rounded-md border border-border p-3">
    <div
      class="flex items-center justify-between gap-3 border-b border-border pb-2"
      :class="{ 'opacity-50': !!disabledReason }"
      :title="disabledReason"
    >
      <!-- The heading is the switch's label, so it carries the heading weight
           rather than a plain Label's. -->
      <Label :for="switchId" class="whitespace-nowrap font-semibold">{{ title }}</Label>
      <Checkbox
        v-if="enabled !== undefined"
        :id="switchId"
        :disabled="!!disabledReason"
        :aria-describedby="disabledReason ? reasonId : undefined"
        :model-value="enabled"
        @click="toggle"
      />
    </div>
    <p v-if="disabledReason" :id="reasonId" class="text-xs text-muted-foreground">
      {{ disabledReason }}
    </p>
    <slot />
  </div>
</template>
