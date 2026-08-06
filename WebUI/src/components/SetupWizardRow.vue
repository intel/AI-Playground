<script setup lang="ts">
// Presentational row for the setup wizard's "Components" column. Every regular
// backend row and the Cloud Mode row render through this so the status bubble,
// name/version/info-link, install-progress spinner, error/repair actions and the
// enable toggle stay identical everywhere. The variant-specific settings menu is
// provided via the #options slot; per-row actions are emitted to the parent.
import { computed } from 'vue'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { useI18N } from '@/assets/js/store/i18n'

export type SetupWizardRowView = {
  displayName: string
  statusColor: string
  statusText: string
  versionDisplay?: string
  enabled: boolean
  toggleDisabled?: boolean
  toggleTooltip?: string
  isInstalling?: boolean
  installProgressText?: string | null
  /** Dimmed + "Unavailable" hint when false. Defaults to available. */
  availableInCurrentMode?: boolean
  /** Optional external "info & license" link shown next to the name. */
  infoUrl?: string
  /** Show the inline "Repair" button (failed + available backends). */
  showRepair?: boolean
  /** Disable the repair button while another install is running. */
  repairDisabled?: boolean
  /** Show the "View error log" button. */
  showError?: boolean
}

const props = defineProps<{ row: SetupWizardRowView }>()
const emit = defineEmits<{
  toggle: [boolean]
  repair: []
  showError: []
}>()

const languages = useI18N().state
const available = computed(() => props.row.availableInCurrentMode ?? true)
</script>

<template>
  <div
    role="group"
    :aria-label="row.displayName"
    class="flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-muted/30 transition-colors"
    :class="{
      'border-border': available,
      'border-border/50 opacity-50': !available,
    }"
  >
    <!-- Status bubble -->
    <TooltipProvider :delay-duration="200">
      <Tooltip>
        <TooltipTrigger as-child>
          <span
            class="w-2.5 h-2.5 rounded-full shrink-0"
            :style="{ backgroundColor: row.statusColor }"
          ></span>
        </TooltipTrigger>
        <TooltipContent side="right" class="text-xs">
          {{ row.statusText }}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>

    <!-- Name + version + info link -->
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-1.5">
        <span class="text-sm font-medium leading-tight">{{ row.displayName }}</span>
        <a
          v-if="row.infoUrl"
          :href="row.infoUrl"
          target="_blank"
          class="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Component info &amp; license"
        >
          <svg
            class="w-3.5 h-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
        </a>
      </div>
      <div v-if="row.versionDisplay" class="text-xs text-muted-foreground leading-tight">
        {{ row.versionDisplay }}
      </div>
    </div>

    <!-- Unavailable tooltip -->
    <TooltipProvider v-if="!available" :delay-duration="200">
      <Tooltip>
        <TooltipTrigger as-child>
          <span class="text-xs text-muted-foreground italic">
            {{ languages.SETUP_WIZARD_UNAVAILABLE || 'Unavailable' }}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" class="text-xs max-w-[200px]">
          {{
            languages.SETUP_WIZARD_UNAVAILABLE_TOOLTIP ||
            'This component is not available in the selected product mode.'
          }}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>

    <!-- Per-row action -->
    <div class="flex items-center gap-2 shrink-0">
      <template v-if="row.isInstalling">
        <span
          v-if="row.installProgressText"
          class="text-xs text-muted-foreground whitespace-nowrap"
        >
          {{ row.installProgressText }}
        </span>
        <span class="svg-icon i-loading flex-none w-4 h-4"></span>
      </template>
      <button
        v-else-if="row.showRepair"
        @click="emit('repair')"
        :disabled="row.repairDisabled"
        class="text-xs bg-primary/80 hover:bg-primary py-0.5 px-2.5 rounded transition-colors disabled:opacity-50"
      >
        {{ languages.COM_REPAIR || 'Repair' }}
      </button>
    </div>

    <!-- Toggle + gear -->
    <div class="flex items-center gap-2 shrink-0">
      <button
        v-if="row.showError"
        @click="emit('showError')"
        class="text-destructive hover:text-destructive/80 transition-colors"
        title="View error log"
      >
        <svg
          class="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      </button>
      <TooltipProvider :delay-duration="300">
        <Tooltip>
          <TooltipTrigger as-child>
            <span class="inline-flex">
              <Switch
                :model-value="row.enabled"
                :disabled="row.toggleDisabled"
                :aria-label="`Enable ${row.displayName}`"
                @update:model-value="(v: boolean) => emit('toggle', v)"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent v-if="row.toggleTooltip" side="left" class="text-xs">
            {{ row.toggleTooltip }}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <slot name="options" />
    </div>
  </div>
</template>
