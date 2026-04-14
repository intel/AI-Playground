<template>
  <div class="z-10 text-foreground rounded-xl bg-background/70 border border-border shadow-lg">
    <div class="px-20 py-5 max-w-5xl">
      <h1 class="text-center py-1 px-4 rounded-sm text-4xl">
        {{ languages.PRODUCT_MODE_SELECTOR_PAGE_TITLE }}
      </h1>

      <div class="flex flex-col gap-4 pt-8">
        <label
          v-for="option in resolvedOptions"
          :key="option.mode"
          class="flex items-start gap-4 p-5 rounded-lg border cursor-pointer transition-colors"
          :class="
            selectedMode === option.mode
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-border/80'
          "
          @click="selectedMode = option.mode"
        >
          <div class="pt-1 shrink-0">
            <div
              class="w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors"
              :class="
                selectedMode === option.mode
                  ? 'border-primary bg-primary'
                  : 'border-muted-foreground'
              "
            >
              <svg
                v-if="selectedMode === option.mode"
                class="w-4 h-4 text-primary-foreground"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>

          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-4 flex-wrap">
              <div class="flex items-baseline gap-2 flex-wrap min-w-0">
                <span class="text-lg font-bold text-[#00c4fa] tracking-tight -mr-1">{{
                  option.titleOne
                }}</span>
                <span class="text-lg font-bold tracking-tight">{{ option.titleTwo }}</span>
                <span
                  v-if="option.subtitle"
                  class="text-lg font-medium text-muted-foreground tracking-tight"
                >
                  {{ option.subtitle }}
                </span>
              </div>

              <span
                v-if="option.experimental"
                class="text-xs font-semibold uppercase tracking-wider text-gray-400"
              >
                {{ languages.PRODUCT_MODE_BADGE_EXPERIMENTAL }}
              </span>
              <span
                v-if="recommendedMode === option.mode"
                class="text-xs font-semibold uppercase tracking-wider text-green-600 dark:text-green-500"
              >
                {{ languages.PRODUCT_MODE_BADGE_RECOMMENDED }}
              </span>
              <span
                v-else-if="option.mode === 'studio' && recommendedMode === 'essentials'"
                class="text-xs font-semibold uppercase tracking-wider text-amber-500"
              >
                {{ languages.PRODUCT_MODE_BADGE_INSUFFICIENT_HARDWARE }}
              </span>
            </div>

            <p class="text-sm text-foreground pt-1">{{ option.description }}</p>

            <ul
              v-if="(option.features?.length ?? 0) > 0"
              class="text-sm pt-3 pl-5 list-disc space-y-1"
            >
              <li v-for="(feature, idx) in option.features" :key="idx">
                <span class="text-foreground font-medium">{{ feature.label }}</span>
                <span class="text-foreground/90">{{ feature.detail }}</span>
              </li>
            </ul>

            <p class="text-xs text-muted-foreground pt-2 italic">
              {{ languages.PRODUCT_MODE_SUPPORTED_HARDWARE_LEAD }} {{ option.supportedHardware }}
            </p>
          </div>
        </label>
      </div>

      <div class="flex justify-end pt-8">
        <button
          :disabled="!selectedMode"
          @click="confirmSelection"
          class="bg-primary py-2 px-8 rounded text-primary-foreground font-medium disabled:opacity-50"
        >
          {{ languages.PRODUCT_MODE_CONTINUE }}
        </button>
      </div>

      <div class="place-content-end flex gap-2 pt-4">
        <LanguageSelector class="max-w-40" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import LanguageSelector from '@/components/LanguageSelector.vue'
import { useI18N } from '@/assets/js/store/i18n'

const props = defineProps<{
  modeCatalog: ProductModeCatalogEntry[]
  recommendedMode: ProductMode | null
  /** Committed tier from settings; pre-selects this when reopening the manager (matches app header). */
  currentMode?: ProductMode | null
}>()

const emits = defineEmits<{
  (e: 'select', mode: ProductMode): void
}>()

const i18n = useI18N()
const languages = i18n.state

function t(key: string) {
  return i18n.state[key] ?? key
}

const selectedMode = ref<ProductMode | null>(null)

const resolvedOptions = computed(() =>
  props.modeCatalog.map((entry) => ({
    mode: entry.mode,
    experimental: entry.experimental,
    titleOne: t(entry.ui.i18n.titleOne),
    titleTwo: t(entry.ui.i18n.titleTwo),
    subtitle: entry.ui.i18n.subtitle ? t(entry.ui.i18n.subtitle) : '',
    description: t(entry.ui.i18n.description),
    supportedHardware: t(entry.ui.i18n.supportedHardware),
    features: entry.ui.i18n.features?.map((f) => ({
      label: t(f.labelKey),
      detail: t(f.detailKey),
    })),
  })),
)

watch(
  () => props.currentMode,
  (cur) => {
    if (cur != null) {
      selectedMode.value = cur
    }
  },
  { immediate: true },
)

watch(
  () => props.recommendedMode,
  (rec) => {
    if (props.currentMode == null && selectedMode.value === null && rec != null) {
      selectedMode.value = rec
    }
  },
  { immediate: true },
)

function confirmSelection() {
  if (selectedMode.value) {
    emits('select', selectedMode.value)
  }
}
</script>
