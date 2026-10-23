<script setup lang="ts">
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18N } from '@/assets/js/store/i18n'
import { formatBytes } from '@/assets/js/models/library'
import VramChipIcon from '@/components/VramChipIcon.vue'
import { useLlamaCppVramFit, type VramFitTarget } from '@/lib/useLlamaCppVramFit'
import { vramFitBars, type VramFitBars, type VramFitVerdict } from '@/lib/vram'

const props = withDefaults(
  defineProps<{
    /**
     * Defaults to the active model; pass one to judge a model in a list. Already
     * narrowed to llama.cpp by the caller (`llamaCppFitTarget`), since only the
     * caller knows which backend the row it is rendering belongs to.
     */
    model?: VramFitTarget
    iconSize?: string
    delayDuration?: number
  }>(),
  { model: undefined, iconSize: 'size-4', delayDuration: 200 },
)

const i18nState = useI18N().state
const { summary, verdict } = useLlamaCppVramFit(
  props.model ? computed(() => props.model) : undefined,
)

const bars = computed<VramFitBars>(() =>
  summary.value ? vramFitBars(summary.value.current.totalBytes, summary.value.usableBytes) : 1,
)

const LEVEL_KEY: Record<VramFitVerdict, string> = {
  easy: 'VRAM_FIT_LEVEL_EASY',
  tight: 'VRAM_FIT_LEVEL_TIGHT',
  over: 'VRAM_FIT_LEVEL_OVER',
  unknown: 'VRAM_FIT_LEVEL_UNKNOWN',
}

function t(key: string, vars: Record<string, string> = {}): string {
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    i18nState[key] ?? '',
  )
}

const tokens = (count: number) => new Intl.NumberFormat().format(count)

const levelLabel = computed(() => (verdict.value ? t(LEVEL_KEY[verdict.value]) : ''))

// Two lines and no more: what the model costs at the context it will actually run
// at, and that cost against the card. Everything else the estimate knows is detail
// the verdict already answers for.
const breakdownLine = computed(() =>
  summary.value
    ? t('VRAM_FIT_BREAKDOWN', {
        base: formatBytes(summary.value.current.baseBytes),
        context: formatBytes(summary.value.current.contextBytes),
        tokens: tokens(summary.value.current.contextTokens),
      })
    : '',
)

const budgetLine = computed(() =>
  summary.value
    ? t('VRAM_FIT_BUDGET', {
        total: formatBytes(summary.value.current.totalBytes),
        max: formatBytes(summary.value.totalBytes),
      })
    : '',
)
</script>

<template>
  <TooltipProvider v-if="verdict">
    <Tooltip :delay-duration="delayDuration">
      <TooltipTrigger as-child>
        <!-- A row of the picker is itself the control: a nested button would take
             the menu's focus and swallow the click that selects the model. -->
        <component
          :is="model ? 'span' : 'button'"
          :type="model ? undefined : 'button'"
          :role="model ? 'img' : undefined"
          class="flex flex-none items-center cursor-help"
          :aria-label="t('VRAM_FIT_ARIA', { level: levelLabel })"
        >
          <VramChipIcon :verdict="verdict" :bars="bars" :class="iconSize" />
        </component>
      </TooltipTrigger>
      <TooltipContent
        align="start"
        class="max-w-xs bg-card border border-border text-foreground px-3 py-2 z-[200]"
      >
        <p class="text-sm font-semibold">{{ levelLabel }}</p>
        <!-- Nothing was measured, so there is no breakdown to show — only why the
             estimate is missing. -->
        <p v-if="!summary" class="text-xs text-muted-foreground">
          {{ t('VRAM_FIT_UNKNOWN_EXPLANATION') }}
        </p>
        <template v-else>
          <p class="text-xs text-muted-foreground">{{ breakdownLine }}</p>
          <p class="text-xs">{{ budgetLine }}</p>
        </template>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
