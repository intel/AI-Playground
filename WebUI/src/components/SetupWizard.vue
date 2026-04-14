<template>
  <div
    class="z-10 text-foreground rounded-xl bg-background/70 backdrop-blur-sm border border-border shadow-lg"
  >
    <div class="px-12 py-5 max-w-5xl w-5xl">
      <h1 class="text-center py-1 px-4 rounded-sm text-3xl font-bold">
        {{ languages.SETUP_WIZARD_TITLE || 'AI Playground Setup' }}
      </h1>

      <!-- Two-column layout: Product Mode | Components -->
      <div class="flex gap-6 pt-6">
        <!-- Left column: Product Mode -->
        <div class="flex-1 min-w-0">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
            {{ languages.SETUP_WIZARD_MODE_SECTION || 'Product Mode' }}
          </h2>
          <div class="flex flex-col gap-2">
            <label
              v-for="option in resolvedModeOptions"
              :key="option.mode"
              class="flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors"
              :class="
                wizard.pendingProductMode === option.mode
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:border-muted/50'
              "
              @click="wizard.setPendingMode(option.mode)"
            >
              <div class="shrink-0 mt-0.5">
                <div
                  class="w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors"
                  :class="
                    wizard.pendingProductMode === option.mode
                      ? 'border-primary bg-primary'
                      : 'border-muted-foreground'
                  "
                >
                  <svg
                    v-if="wizard.pendingProductMode === option.mode"
                    class="w-2.5 h-2.5 text-primary-foreground"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              </div>
              <div class="min-w-0">
                <div class="flex items-baseline gap-1 flex-wrap">
                  <span class="text-xs font-bold text-[#00c4fa] -mr-0.5">{{
                    option.titleOne
                  }}</span>
                  <span class="text-xs font-bold">{{ option.titleTwo }}</span>
                  <span v-if="option.subtitle" class="text-xs font-medium text-muted-foreground">{{
                    option.subtitle
                  }}</span>
                </div>
                <div class="flex gap-1 pt-0.5">
                  <span
                    v-if="recommendedMode === option.mode"
                    class="text-[9px] font-semibold uppercase tracking-wider text-green-500"
                    >{{ languages.PRODUCT_MODE_BADGE_RECOMMENDED }}</span
                  >
                  <span
                    v-if="option.experimental"
                    class="text-[9px] font-semibold uppercase tracking-wider text-gray-400"
                    >{{ languages.PRODUCT_MODE_BADGE_EXPERIMENTAL }}</span
                  >
                </div>
                <p class="text-[11px] text-muted-foreground pt-1 leading-snug">
                  {{ option.description }}
                </p>
              </div>
            </label>
          </div>
        </div>

        <!-- Right column: Components -->
        <div class="flex-1 min-w-0">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
            {{ languages.SETUP_WIZARD_BACKENDS_SECTION || 'Components' }}
          </h2>

          <div class="flex flex-col gap-1.5">
            <div
              v-for="row in wizard.backendRows"
              :key="row.serviceName"
              class="flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-muted/30 transition-colors"
              :class="{
                'border-border': row.availableInCurrentMode,
                'border-border/50 opacity-50': !row.availableInCurrentMode,
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
                    v-if="getInfoURL(row.serviceName)"
                    :href="getInfoURL(row.serviceName)"
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
                <div class="text-xs text-muted-foreground leading-tight">
                  {{ row.versionDisplay }}
                </div>
              </div>

              <!-- Unavailable tooltip -->
              <TooltipProvider v-if="!row.availableInCurrentMode" :delay-duration="200">
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
                  v-else-if="
                    (row.status === 'failed' || row.status === 'installationFailed') &&
                    row.availableInCurrentMode
                  "
                  @click="wizard.repairBackend(row.serviceName)"
                  :disabled="wizard.isBusy"
                  class="text-xs bg-primary/80 hover:bg-primary py-0.5 px-2.5 rounded transition-colors disabled:opacity-50"
                >
                  {{ languages.COM_REPAIR || 'Repair' }}
                </button>
              </div>

              <!-- Toggle + gear -->
              <div class="flex items-center gap-2 shrink-0">
                <button
                  v-if="row.status === 'failed' || row.status === 'installationFailed'"
                  @click="wizard.showErrorModal(row.serviceName)"
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
                          @update:model-value="
                            (v: boolean) => wizard.toggleBackend(row.serviceName, v)
                          "
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left" class="text-xs">
                      {{ row.toggleTooltip }}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <BackendOptions :backend="row.serviceName" />
              </div>
            </div>
          </div>
          <p class="text-xs text-muted-foreground pt-3">
            {{
              languages.SETUP_WIZARD_BACKENDS_INTRO ||
              'Required components will be installed automatically. Optional components can be toggled on or off.'
            }}
          </p>
        </div>
      </div>

      <!-- Primary CTA + Close -->
      <div class="flex items-center justify-between pt-4">
        <div class="flex items-center gap-2">
          <LanguageSelector class="max-w-40" />
          <button
            @click="openDebug"
            class="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {{ languages.COM_DEBUG || 'Debug' }}
          </button>
        </div>
        <div class="flex gap-3">
          <button
            v-if="wizard.canClose"
            @click="wizard.dismiss()"
            class="py-2 px-6 rounded text-sm font-medium border border-border hover:bg-muted transition-colors"
          >
            {{ languages.COM_CLOSE || 'Close' }}
          </button>
          <button
            :disabled="!wizard.canRunPrimary"
            @click="wizard.commitAndInstall()"
            class="bg-primary py-2 px-8 rounded text-primary-foreground text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {{ wizard.primaryLabel }}
          </button>
        </div>
      </div>

      <!-- Terms -->
      <div class="pt-4">
        <p class="text-xs text-muted-foreground">{{ languages.BACKEND_TERMS_AND_CONDITIONS }}</p>
      </div>
    </div>

    <!-- Error Details Modal -->
    <ErrorDetailsModal
      :is-open="wizard.errorModalOpen"
      :service-name="wizard.errorModalServiceName ?? ''"
      :error-details="wizard.errorModalDetails"
      @close="wizard.closeErrorModal()"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useProductMode } from '@/assets/js/store/productMode'
import { useI18N } from '@/assets/js/store/i18n'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import BackendOptions from '@/components/BackendOptions.vue'
import ErrorDetailsModal from '@/components/ErrorDetailsModal.vue'
import LanguageSelector from '@/components/LanguageSelector.vue'

const wizard = useSetupWizard()
const productModeStore = useProductMode()
const i18n = useI18N()
const languages = i18n.state

function t(key: string) {
  return i18n.state[key] ?? key
}

const recommendedMode = computed(
  () => productModeStore.hardwareRecommendation?.recommendedMode ?? null,
)

const resolvedModeOptions = computed(() => {
  const catalog = productModeStore.hardwareRecommendation?.modeCatalog ?? []
  return catalog.map((entry) => ({
    mode: entry.mode,
    experimental: entry.experimental,
    titleOne: t(entry.ui.i18n.titleOne),
    titleTwo: t(entry.ui.i18n.titleTwo),
    subtitle: entry.ui.i18n.subtitle ? t(entry.ui.i18n.subtitle) : '',
    description: t(entry.ui.i18n.description),
    supportedHardware: t(entry.ui.i18n.supportedHardware),
  }))
})

function getInfoURL(serviceName: string): string | undefined {
  switch (serviceName) {
    case 'ai-backend':
      return 'https://github.com/intel/ai-playground'
    case 'comfyui-backend':
      return 'https://github.com/comfyanonymous/ComfyUI'
    case 'llamacpp-backend':
      return 'https://github.com/abetlen/llama-cpp-python'
    case 'openvino-backend':
      return 'https://github.com/openvinotoolkit/model_server'
    default:
      return undefined
  }
}

function openDebug() {
  window.electronAPI.openDevTools()
}
</script>
