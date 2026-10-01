<script setup lang="ts">
// A titled box around related component rows in the setup wizard's "Components"
// column. The wizard used to render one flat list of every backend, which made
// closely-related pieces (the core service and the features layered on it, or the
// two audio sidecars) read as unrelated peers. A group gives them one heading, one
// optional explanation, and one master toggle that flips every child that CAN be
// flipped — a required child (e.g. the core backend) is left alone.
//
// Children are passed in the default slot by the parent, which owns their per-row
// settings menus; they should be rendered with SetupWizardRow's `compact` prop so
// the group supplies the border and the rows read as its contents.
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import InfoHint from '@/components/InfoHint.vue'

export type SetupWizardGroupToggle = {
  enabled: boolean
  disabled?: boolean
  tooltip?: string
}

defineProps<{
  title: string
  /** Explanatory ⓘ next to the title. Omit for a group that needs no caveat. */
  infoTooltip?: string
  /** External "info & license" link for the group as a whole — it belongs on the
   *  heading rather than on whichever child happens to own the project page. */
  infoUrl?: string
  /** Master toggle. Omit when no child can be toggled (nothing to control). */
  toggle?: SetupWizardGroupToggle | null
}>()

const emit = defineEmits<{ toggle: [boolean] }>()
</script>

<template>
  <div role="group" :aria-label="title" class="min-w-0 rounded-lg border border-border bg-muted/30">
    <div class="flex items-center gap-1.5 px-3 py-2">
      <span class="text-sm font-medium leading-tight">{{ title }}</span>
      <InfoHint v-if="infoTooltip" :text="infoTooltip" />
      <InfoHint
        v-if="infoUrl"
        :href="infoUrl"
        text="Component info & license — opens the project page"
      />
      <div class="flex-1"></div>
      <TooltipProvider v-if="toggle" :delay-duration="300">
        <Tooltip>
          <TooltipTrigger as-child>
            <span class="inline-flex">
              <Switch
                :model-value="toggle.enabled"
                :disabled="toggle.disabled"
                :aria-label="`Enable all ${title}`"
                @update:model-value="(v: boolean) => emit('toggle', v)"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent v-if="toggle.tooltip" side="left" class="text-xs">
            {{ toggle.tooltip }}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>

    <div class="flex min-w-0 flex-col border-t border-border/60 px-1.5 py-1">
      <slot />
    </div>
  </div>
</template>
