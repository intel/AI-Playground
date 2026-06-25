<template>
  <div class="z-10 text-foreground rounded-xl bg-background/70 border border-border shadow-lg">
    <div class="px-20 py-5 max-w-5xl">
      <h1 class="text-center py-1 px-4 rounded-sm text-4xl">
        {{
          productModeStore.productMode === 'essentials'
            ? languages.BACKEND_MANAGE_ESSENTIALS
            : languages.BACKEND_MANAGE
        }}
      </h1>
      <div class="">
        <p class="text-lg text-left pt-3 pb-3">
          {{ languages.BACKEND_REQUIRED_COMPONENTS_MESSAGE }}
        </p>
        <p class="text-lg text-left pt-3 pb-7">
          {{ languages.BACKEND_OPTIONAL_COMPONENTS_MESSAGE }}
        </p>
        <table class="text-center w-full" style="table-layout: fixed">
          <thead>
            <tr class="font-bold">
              <td style="text-align: left">{{ languages.BACKEND_SINGLE_COMPONENT }}</td>
              <td>{{ languages.BACKEND_TYPE }}</td>
              <td>{{ languages.BACKEND_INFORMATION }}</td>
              <td>{{ languages.BACKEND_ENABLE }}</td>
              <td>Version</td>
              <td>{{ languages.BACKEND_STATUS }}</td>
              <td>{{ languages.BACKEND_ACTION }}</td>
              <td class="w-6"></td>
            </tr>
          </thead>
          <tbody>
            <tr v-for="component in components" :key="component.serviceName">
              <td class="text-left">{{ mapServiceNameToDisplayName(component.serviceName) }}</td>
              <td class="text-center">
                {{ component.isRequired ? languages.BACKEND_REQUIRED : languages.BACKEND_OPTIONAL }}
              </td>
              <td>
                <a :href="getInfoURL(component.serviceName)" target="_blank">
                  <span
                    v-show="!!getInfoURL(component.serviceName)"
                    style="vertical-align: middle"
                    class="svg-icon i-info w-7 h-7 px-6"
                  ></span>
                </a>
                <p v-show="!getInfoURL(component.serviceName)">-</p>
              </td>
              <td>
                <Checkbox
                  v-if="llamacppGgufCheckboxVisible(component)"
                  class="mx-auto"
                  :model-value="component.enabled"
                  @update:model-value="
                    (value: boolean | 'indeterminate') => {
                      syncInstallSelection(component.serviceName, value === true)
                    }
                  "
                  :disabled="
                    component.isRequired ||
                    (component.serviceName === 'llamacpp-backend' &&
                      backendServices.llamaCppBuildVariant === 'ssd-offload')
                  "
                />
                <p v-else>-</p>
              </td>
              <td class="text-center">
                <!-- AI Backend: Simple app version display -->
                <div
                  v-if="component.serviceName === 'ai-backend'"
                  class="text-sm text-muted-foreground"
                >
                  {{ appVersion }}
                </div>

                <!-- Llama.cpp GGUF row: version reflects standard tree only (not Phison install). -->
                <TooltipProvider
                  v-else-if="component.serviceName === 'llamacpp-backend'"
                  :delay-duration="200"
                >
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <div class="flex flex-col items-center gap-0.5 text-sm cursor-help">
                        <div class="flex items-center gap-1.5">
                          <span
                            v-if="llamacppStandardRowIsSetUp(component)"
                            :class="getLlamaStandardVersionStatusClass(component)"
                            style="text-decoration: underline dotted 1px"
                          >
                            {{ formatLlamaStandardInstalled(component) }}
                          </span>
                          <span
                            v-else
                            class="underline decoration-dotted decoration-1"
                            :class="getLlamaStandardUninstalledStatusClass(component)"
                          >
                            Not installed
                          </span>
                          <span
                            v-if="
                              llamacppStandardRowIsSetUp(component) &&
                              isLlamaStandardVersionUpToDate(component)
                            "
                            class="text-green-500"
                            title="Up to date"
                          >
                            ✓
                          </span>
                          <span
                            v-else-if="
                              llamacppStandardRowIsSetUp(component) &&
                              hasLlamaStandardVersionChange(component)
                            "
                            :class="getLlamaStandardVersionChangeClass(component)"
                            :title="
                              isLlamaStandardUpgrade(component)
                                ? 'Update available'
                                : 'Downgrade pending'
                            "
                          >
                            {{ getLlamaStandardVersionChangeIcon(component) }}
                          </span>
                        </div>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent
                      class="bg-card border border-border text-foreground p-3 z-[200]"
                    >
                      <div class="text-sm space-y-1">
                        <div class="flex justify-between gap-4">
                          <span class="text-muted-foreground">Installed:</span>
                          <span>{{ formatLlamaStandardInstalled(component) }}</span>
                        </div>
                        <div class="flex justify-between gap-4">
                          <span class="text-muted-foreground">Latest Supported:</span>
                          <span>{{ formatOfficialTarget(component.serviceName) }}</span>
                        </div>
                        <div
                          v-if="hasUserOverride(component.serviceName)"
                          class="flex justify-between gap-4 text-amber-400"
                        >
                          <span>Settings Override:</span>
                          <span>{{ formatUserOverride(component.serviceName) }}</span>
                        </div>
                        <div class="border-t border-border pt-1 mt-1 flex justify-between gap-4">
                          <span class="text-muted-foreground">Effective:</span>
                          <span>
                            {{ formatEffectiveTarget(component.serviceName) }}
                            <span
                              v-if="hasUserOverride(component.serviceName)"
                              class="text-amber-400"
                            >
                              (override)
                            </span>
                          </span>
                        </div>
                        <div
                          v-if="
                            hasUserOverride(component.serviceName) &&
                            hasNewerSupportedVersion(component.serviceName)
                          "
                          class="border-t border-border pt-1 mt-1 text-xs text-amber-400"
                        >
                          A newer supported version is available
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <!-- Other backends: Version with tooltip -->
                <TooltipProvider v-else :delay-duration="200">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <div class="flex flex-col items-center gap-0.5 text-sm cursor-help">
                        <!-- Compact: Installed version + status icon -->
                        <div class="flex items-center gap-1.5">
                          <span
                            v-if="component.isSetUp"
                            :class="getVersionStatusClass(component.serviceName)"
                            style="text-decoration: underline dotted 1px"
                          >
                            {{ formatInstalledVersion(component.serviceName) }}
                          </span>
                          <span
                            v-else
                            class="underline decoration-dotted decoration-1"
                            :class="getUninstalledStatusClass(component.serviceName)"
                          >
                            Not installed
                          </span>
                          <!-- Status icon -->
                          <span
                            v-if="component.isSetUp && isVersionUpToDate(component.serviceName)"
                            class="text-green-500"
                            title="Up to date"
                          >
                            ✓
                          </span>
                          <span
                            v-else-if="component.isSetUp && hasVersionChange(component.serviceName)"
                            :class="getVersionChangeClass(component.serviceName)"
                            :title="
                              isUpgrade(component.serviceName)
                                ? 'Update available'
                                : 'Downgrade pending'
                            "
                          >
                            {{ getVersionChangeIcon(component.serviceName) }}
                          </span>
                        </div>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent
                      class="bg-card border border-border text-foreground p-3 z-[200]"
                    >
                      <!-- Expanded: All version details -->
                      <div class="text-sm space-y-1">
                        <div class="flex justify-between gap-4">
                          <span class="text-muted-foreground">Installed:</span>
                          <span>{{ formatInstalledVersion(component.serviceName) }}</span>
                        </div>
                        <div class="flex justify-between gap-4">
                          <span class="text-muted-foreground">Latest Supported:</span>
                          <span>{{ formatOfficialTarget(component.serviceName) }}</span>
                        </div>
                        <div
                          v-if="hasUserOverride(component.serviceName)"
                          class="flex justify-between gap-4 text-amber-400"
                        >
                          <span>Settings Override:</span>
                          <span>{{ formatUserOverride(component.serviceName) }}</span>
                        </div>
                        <div class="border-t border-border pt-1 mt-1 flex justify-between gap-4">
                          <span class="text-muted-foreground">Effective:</span>
                          <span>
                            {{ formatEffectiveTarget(component.serviceName) }}
                            <span
                              v-if="hasUserOverride(component.serviceName)"
                              class="text-amber-400"
                            >
                              (override)
                            </span>
                          </span>
                        </div>
                        <!-- Hint when newer supported version is available -->
                        <div
                          v-if="
                            hasUserOverride(component.serviceName) &&
                            hasNewerSupportedVersion(component.serviceName)
                          "
                          class="border-t border-border pt-1 mt-1 text-xs text-amber-400"
                        >
                          A newer supported version is available
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </td>
              <td :style="{ color: componentStatusIndicatorColor(component) }" class="">
                <div class="flex items-center gap-2">
                  <span>{{ mapToDisplayStatus(llamacppStandardRowStatus(component)) }}</span>
                  <button
                    v-if="
                      llamacppStandardRowStatus(component) === 'failed' ||
                      llamacppStandardRowStatus(component) === 'installationFailed'
                    "
                    @click="showErrorDetails(component.serviceName)"
                    class="text-primary hover:text-primary/80 transition-colors"
                    title="View error details"
                  >
                    <span class="svg-icon i-info w-5 h-5 align-text-top"></span>
                  </button>
                </div>
              </td>
              <td>
                <span
                  v-if="rowShowsLoadingSpinner(component)"
                  class="svg-icon i-loading flex-none w-5 h-5"
                ></span>
                <button
                  v-else-if="needsInstall(component)"
                  @click="() => installBackend(component.serviceName)"
                  :disabled="!component.enabled || isSomethingLoading()"
                  class="bg-primary py-1 px-4 rounded"
                >
                  {{ languages.COM_INSTALL }}
                </button>
                <button
                  v-else-if="
                    llamacppStandardRowStatus(component) === 'failed' ||
                    llamacppStandardRowStatus(component) === 'installationFailed'
                  "
                  @click="() => repairBackend(component.serviceName)"
                  :disabled="!component.enabled || isSomethingLoading()"
                  class="bg-primary py-1 px-4 rounded"
                >
                  {{ languages.COM_REPAIR }}
                </button>
                <button
                  v-else-if="llamacppStandardRowStatus(component) === 'running'"
                  @click="() => restartBackend(component.serviceName)"
                  :disabled="isSomethingLoading()"
                  class="bg-primary py-1 px-4 rounded"
                >
                  {{ languages.COM_RESTART }}
                </button>
                <button
                  v-else-if="
                    llamacppStandardRowStatus(component) === 'stopped' ||
                    llamacppStandardRowStatus(component) === 'notYetStarted'
                  "
                  @click="() => restartBackend(component.serviceName)"
                  :disabled="isSomethingLoading()"
                  class="bg-primary py-1 px-4 rounded"
                >
                  {{ languages.COM_START }}
                </button>

                <p v-else>-</p>
              </td>
              <td class="w-6">
                <BackendOptions :backend="component.serviceName"></BackendOptions>
              </td>
            </tr>
            <tr v-if="backendServices.phisonSsdDetected">
              <td class="text-left">
                <span class="inline-flex items-center gap-2">
                  <span
                    class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    title="Llama.cpp-Phison aiDAPTIV+"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M4 7a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7z"
                        stroke="currentColor"
                        stroke-width="1.75"
                      />
                      <path
                        d="M8 11h8M8 15h5"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                      />
                    </svg>
                  </span>
                  <span>{{
                    languages.BACKEND_PHISON_AIDAPTIV_ROW || 'Llama.cpp-Phison aiDAPTIV+ SSD'
                  }}</span>
                </span>
              </td>
              <td class="text-center">{{ languages.BACKEND_OPTIONAL }}</td>
              <td class="text-center">—</td>
              <td class="text-center">
                <Switch
                  class="mx-auto"
                  :model-value="backendServices.llamaCppBuildVariant === 'ssd-offload'"
                  @update:model-value="togglePhisonAidaptivInstall"
                />
              </td>
              <td class="text-center text-xs text-muted-foreground">
                {{
                  formatVersion(
                    backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
                      ?.llamaCppPhisonInstalledVersion,
                  )
                }}
              </td>
              <td class="text-center" :style="{ color: llamacppPhisonStatusIndicatorColor }">
                {{ mapToDisplayStatus(llamacppPhisonRowStatus) }}
              </td>
              <td class="text-center text-muted-foreground text-sm">—</td>
              <td class="w-6">
                <PhisonAidaptivOptions />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- close/install all//continue -->
      <div class="dialog-container flex justify-between z-10 pt-10" style="display: flex">
        <button
          :style="{ visibility: convertVisibility(!somethingChanged) }"
          :disabled="!CanCloseInstallations()"
          @click="closeInstallations"
          class="flex bg-primary py-1 px-4 rounded"
        >
          {{ languages.COM_CLOSE }}
        </button>
        <button
          :disabled="!areBoxesChecked() || isSomethingLoading() || isEverythingRunning()"
          @click="installAllSelected"
          class="flex bg-primary py-1 px-4 rounded"
        >
          {{ languages.COM_INSTALL_ALL }}
        </button>
        <button
          :style="{
            visibility: convertVisibility(somethingChanged && !areBoxesChecked()),
          }"
          :disabled="!CanCloseInstallations()"
          @click="closeInstallations"
          class="flex bg-primary py-1 px-4 rounded"
        >
          {{ languages.COM_CONTINUE }}
        </button>
      </div>
      <!-- terms and conditions -->
      <div class="dialog-container z-10 pt-10" style="display: flex">
        <p>{{ languages.BACKEND_TERMS_AND_CONDITIONS }}</p>
      </div>
      <!-- Change Language Settings -->
      <div class="place-content-end flex gap-2">
        <LanguageSelector class="max-w-40"></LanguageSelector>
        <button @click="openDebug" class="v-radio-block">{{ languages.COM_DEBUG }}</button>
      </div>
    </div>

    <!-- Error Details Modal -->
    <ErrorDetailsModal
      :is-open="errorModalOpen"
      :service-name="selectedServiceName"
      :error-details="selectedErrorDetails"
      @close="closeErrorModal"
    />
  </div>
</template>

<script setup lang="ts">
import {
  mapServiceNameToDisplayName,
  mapStatusToColor,
  mapToDisplayStatus,
  compareVersions,
} from '@/lib/utils.ts'
import * as toast from '@/assets/js/toast.ts'
import { useBackendServices } from '@/assets/js/store/backendServices'
import LanguageSelector from '@/components/LanguageSelector.vue'
import BackendOptions from '@/components/BackendOptions.vue'
import PhisonAidaptivOptions from '@/components/PhisonAidaptivOptions.vue'
import { Switch } from '@/components/ui/switch'
import ErrorDetailsModal from '@/components/ErrorDetailsModal.vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import type { ErrorDetails } from '../../electron/subprocesses/service'
import { useProductMode } from '@/assets/js/store/productMode'

const emits = defineEmits<{
  (e: 'close'): void
}>()

type ExtendedApiServiceInformation = ApiServiceInformation & {
  enabled: boolean
  isLoading: boolean
}

const backendServices = useBackendServices()
const productModeStore = useProductMode()

// App version for AI Backend display (fetched directly to avoid timing issues with globalSetup.initSetup)
const appVersion = ref('...')
window.electronAPI.getInitSetting().then((data) => {
  appVersion.value = data.version
})

let toBeInstalledQueue: ExtendedApiServiceInformation[] = []

const loadingComponents = ref(new Set<string>())
const somethingChanged = ref(false)

// Error details modal state
const errorModalOpen = ref(false)
const selectedServiceName = ref('')
const selectedErrorDetails = ref<ErrorDetails | null>(null)

const alreadyInstalledOrRequiredComponents = computed(
  () =>
    new Set(
      backendServices.info
        .filter((item) => item.isSetUp || item.isRequired)
        .map((item) => item.serviceName),
    ),
)
const toBeInstalledComponents = ref(new Set<BackendServiceName>())

function togglePhisonAidaptivInstall(enabled: boolean) {
  if (enabled) {
    backendServices.llamaCppBuildVariant = 'ssd-offload'
    toBeInstalledComponents.value.add('llamacpp-backend')
  } else {
    backendServices.llamaCppBuildVariant = 'standard'
  }
  toBeInstalledComponents.value = new Set(toBeInstalledComponents.value)
}

/** Must replace the Set so Vue tracks the ref; in-place .add/.delete does not update dependents. */
function syncInstallSelection(serviceName: BackendServiceName, selected: boolean) {
  const next = new Set(toBeInstalledComponents.value)
  if (selected) next.add(serviceName)
  else next.delete(serviceName)
  toBeInstalledComponents.value = next
}

const components = computed(() => {
  const isNvidiaMode = productModeStore.productMode === 'nvidia'
  return backendServices.info
    .filter((item) => !(isNvidiaMode && item.serviceName === 'openvino-backend'))
    .map((item) => ({
      enabled:
        alreadyInstalledOrRequiredComponents.value.has(item.serviceName) ||
        toBeInstalledComponents.value.has(item.serviceName),
      isLoading: loadingComponents.value.has(item.serviceName),
      ...item,
    }))
})

/** Status column for Phison row — hides "installing" when a standard-only Llama.cpp setup runs. */
const llamacppPhisonRowStatus = computed((): BackendStatus => {
  const info = backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
  const status = info?.status ?? 'notInstalled'
  if (backendServices.llamaCppBuildVariant === 'standard' && status === 'installing') {
    return 'notInstalled'
  }
  if (
    backendServices.llamaCppBuildVariant === 'standard' &&
    (info?.llamaCppPhisonArtifactReady ?? false)
  ) {
    return 'stopped'
  }
  return status
})

function llamacppStandardRowStatus(component: ExtendedApiServiceInformation): BackendStatus {
  if (component.serviceName !== 'llamacpp-backend') return component.status
  if (backendServices.llamaCppBuildVariant === 'ssd-offload' && component.status === 'installing') {
    return 'notInstalled'
  }
  return component.status
}

/** Status column text color: grey = not installed / inactive; green = that build installed with toggle on. */
function componentStatusIndicatorColor(component: ExtendedApiServiceInformation): string {
  if (component.serviceName !== 'llamacpp-backend') {
    return mapStatusToColor(component.status)
  }
  const st = llamacppStandardRowStatus(component)
  if (st === 'failed' || st === 'installationFailed') return mapStatusToColor(st)
  if (st === 'installing' || st === 'starting' || st === 'stopping') return mapStatusToColor(st)

  const standardReady = component.llamaCppStandardArtifactReady ?? false
  if (!standardReady) return mapStatusToColor('notInstalled')

  if (backendServices.llamaCppBuildVariant !== 'standard') {
    return mapStatusToColor('notInstalled')
  }

  const toggledOn = component.enabled
  const running = st === 'running'
  if (standardReady && (toggledOn || running)) {
    return mapStatusToColor('running')
  }
  return mapStatusToColor('notInstalled')
}

const llamacppPhisonStatusIndicatorColor = computed(() => {
  const info = backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
  const st = llamacppPhisonRowStatus.value
  if (st === 'failed' || st === 'installationFailed') return mapStatusToColor(st)
  if (st === 'installing' || st === 'starting' || st === 'stopping') return mapStatusToColor(st)

  const phisonReady = info?.llamaCppPhisonArtifactReady ?? false
  if (!phisonReady) return mapStatusToColor('notInstalled')

  if (backendServices.llamaCppBuildVariant === 'ssd-offload') {
    return mapStatusToColor('running')
  }
  return mapStatusToColor('notInstalled')
})

function llamacppStandardRowIsSetUp(component: ExtendedApiServiceInformation): boolean {
  if (component.serviceName !== 'llamacpp-backend') return component.isSetUp
  return component.llamaCppStandardArtifactReady ?? false
}

/** GGUF row checkbox: after switching from Phison, service may still be "running" until standard GGUF exists — keep checkbox usable. */
function llamacppGgufCheckboxVisible(component: ExtendedApiServiceInformation): boolean {
  if (component.serviceName !== 'llamacpp-backend') {
    return component.status !== 'running' && !component.isLoading
  }
  if (component.isLoading) return false
  if (backendServices.llamaCppBuildVariant === 'ssd-offload') {
    return component.status !== 'running'
  }
  if (!llamacppStandardRowIsSetUp(component)) {
    return component.status !== 'installing'
  }
  return component.status !== 'running'
}

/** Standard GGUF install: any non-installing status while variant is standard and llama-cpp/ tree is missing. */
function llamacppStandardNeedsInstall(component: ExtendedApiServiceInformation): boolean {
  if (component.serviceName !== 'llamacpp-backend') return false
  if (backendServices.llamaCppBuildVariant !== 'standard') return false
  if (llamacppStandardRowIsSetUp(component)) return false
  return component.status !== 'installing'
}

/**
 * Unified per-row "needs Install button" check. For llamacpp this delegates
 * to the variant-aware standard helper. For every other backend a fresh
 * `notInstalled` status is what the Install button is for — previously every
 * row went through `llamacppStandardNeedsInstall`, which short-circuits
 * `false` for non-llama services and left the Install column blank for
 * comfyui/openvino/ai-backend/home-agent on a fresh install.
 */
function needsInstall(component: ExtendedApiServiceInformation): boolean {
  if (component.serviceName === 'llamacpp-backend') {
    return llamacppStandardNeedsInstall(component)
  }
  return component.status === 'notInstalled'
}

function formatLlamaStandardInstalled(component: ExtendedApiServiceInformation): string {
  const v = component.llamaCppStandardInstalledVersion
  if (v) return formatVersion(v)
  return '-'
}

function rowShowsLoadingSpinner(component: ExtendedApiServiceInformation): boolean {
  if (!component.isLoading) return false
  if (
    component.serviceName === 'llamacpp-backend' &&
    backendServices.llamaCppBuildVariant === 'ssd-offload'
  ) {
    return false
  }
  return true
}

function hasLlamaStandardVersionChange(component: ExtendedApiServiceInformation): boolean {
  if (component.serviceName !== 'llamacpp-backend') return hasVersionChange(component.serviceName)
  const effectiveTarget = getEffectiveTarget(component.serviceName)
  const installed = component.llamaCppStandardInstalledVersion
  if (!effectiveTarget?.version || !installed?.version) return false
  const installedNorm = normalizeVersionForComparison(component.serviceName, installed.version)
  const targetNorm = normalizeVersionForComparison(component.serviceName, effectiveTarget.version)
  return installedNorm !== targetNorm
}

function isLlamaStandardVersionUpToDate(component: ExtendedApiServiceInformation): boolean {
  if (component.serviceName !== 'llamacpp-backend') return isVersionUpToDate(component.serviceName)
  const vs = backendServices.versionState['llamacpp-backend']
  const effectiveTarget = getEffectiveTarget(component.serviceName)
  const installed = component.llamaCppStandardInstalledVersion
  if (!vs.target || !effectiveTarget || !installed?.version) return false
  return !hasLlamaStandardVersionChange(component)
}

function isLlamaStandardUpgrade(component: ExtendedApiServiceInformation): boolean | null {
  if (component.serviceName !== 'llamacpp-backend') return isUpgrade(component.serviceName)
  const effectiveTarget = getEffectiveTarget(component.serviceName)
  const installed = component.llamaCppStandardInstalledVersion
  if (!effectiveTarget?.version || !installed?.version) return null
  const installedNorm = normalizeVersionForComparison(component.serviceName, installed.version)
  const targetNorm = normalizeVersionForComparison(component.serviceName, effectiveTarget.version)
  if (compareVersions(installedNorm, targetNorm) < 0) return true
  if (compareVersions(installedNorm, targetNorm) > 0) return false
  return null
}

function getLlamaStandardVersionChangeIcon(component: ExtendedApiServiceInformation): string {
  if (component.serviceName !== 'llamacpp-backend')
    return getVersionChangeIcon(component.serviceName)
  const upgrading = isLlamaStandardUpgrade(component)
  if (upgrading === true) return '↑'
  if (upgrading === false) return '↓'
  return '⚠'
}

function getLlamaStandardVersionChangeClass(component: ExtendedApiServiceInformation): string {
  if (component.serviceName !== 'llamacpp-backend')
    return getVersionChangeClass(component.serviceName)
  const upgrading = isLlamaStandardUpgrade(component)
  if (upgrading === true) return 'text-green-500'
  return 'text-amber-500'
}

function getLlamaStandardVersionStatusClass(component: ExtendedApiServiceInformation): string {
  if (component.serviceName !== 'llamacpp-backend')
    return getVersionStatusClass(component.serviceName)
  if (hasLlamaStandardVersionChange(component) || hasNewerSupportedVersion(component.serviceName)) {
    return 'text-amber-500'
  }
  return 'text-foreground'
}

function getLlamaStandardUninstalledStatusClass(component: ExtendedApiServiceInformation): string {
  if (component.serviceName !== 'llamacpp-backend')
    return getUninstalledStatusClass(component.serviceName)
  if (hasLlamaStandardVersionChange(component) || hasNewerSupportedVersion(component.serviceName)) {
    return 'text-amber-500'
  }
  return 'text-muted-foreground'
}

function isSomethingLoading(): boolean {
  return components.value.some((item) => item.isLoading)
}

async function installBackend(name: BackendServiceName) {
  somethingChanged.value = true
  loadingComponents.value.add(name)
  const setupProgress = await backendServices.setUpService(name)
  console.log('setup finished with', setupProgress)
  if (setupProgress.success) {
    await restartBackend(name)
  } else {
    const errorMessage = setupProgress.errorDetails
      ? 'Setup failed - Click the info icon for details'
      : 'Setup failed'
    toast.error(errorMessage)
    loadingComponents.value.delete(name)
  }
}

async function repairBackend(name: BackendServiceName) {
  loadingComponents.value.add(name)
  const stopStatus = await backendServices.stopService(name)
  if (stopStatus !== 'stopped') {
    toast.error('Service failed to stop')
    return
  }
  await installBackend(name)
}

async function restartBackend(name: BackendServiceName) {
  loadingComponents.value.add(name)
  const stopStatus = await backendServices.stopService(name)
  if (stopStatus !== 'stopped') {
    toast.error('Service failed to stop')
    loadingComponents.value.delete(name)
    return
  }

  try {
    const startStatus = await backendServices.startService(name)
    if (startStatus !== 'running') {
      // Service failed to start - show detailed error message
      const errorDetails = backendServices.getServiceErrorDetails(name)
      const errorMessage = errorDetails
        ? 'Service failed to start - Click the info icon for details'
        : 'Service failed to start'
      toast.error(errorMessage)
      loadingComponents.value.delete(name)
      return
    }
  } catch (error) {
    // Exception during startup - show detailed error message
    const errorDetails = backendServices.getServiceErrorDetails(name)
    const errorMessage = errorDetails
      ? 'Service startup failed - Click the info icon for details'
      : `Service startup failed: ${error instanceof Error ? error.message : String(error)}`
    toast.error(errorMessage)
    loadingComponents.value.delete(name)
    return
  }

  loadingComponents.value.delete(name)
}

async function installAllSelected() {
  toBeInstalledQueue = components.value.filter((item) => {
    if (!item.enabled) return false
    if (item.serviceName === 'llamacpp-backend') {
      if (item.status === 'installing') return false
      if (backendServices.llamaCppBuildVariant === 'standard') {
        return (
          !llamacppStandardRowIsSetUp(item) ||
          item.status === 'failed' ||
          item.status === 'installationFailed'
        )
      }
      return (
        !(item.llamaCppPhisonArtifactReady ?? false) ||
        item.status === 'failed' ||
        item.status === 'installationFailed'
      )
    }
    return (
      item.status === 'notInstalled' ||
      item.status === 'failed' ||
      item.status === 'installationFailed'
    )
  })
  toBeInstalledQueue.forEach((item) => loadingComponents.value.add(item.serviceName))
  for (const component of toBeInstalledQueue) {
    if (component.status === 'failed' || component.status == 'installationFailed') {
      await repairBackend(component.serviceName)
    } else {
      await installBackend(component.serviceName)
    }
  }
}

function closeInstallations() {
  emits('close')
}

function getInfoURL(serviceName: string) {
  switch (serviceName) {
    case 'ai-backend':
      return 'https://github.com/intel/ai-playground'
    case 'comfyui-backend':
      return 'https://github.com/comfyanonymous/ComfyUI'
    case 'llamacpp-backend':
      return 'https://github.com/abetlen/llama-cpp-python'
    case 'openvino-backend':
      return 'https://github.com/openvinotoolkit/openvino.genai'
    default:
      return undefined
  }
}

function openDebug() {
  window.electronAPI.openDevTools()
}

function CanCloseInstallations() {
  return components.value.every((i) => i.status === 'running' || !i.isRequired)
}

function isEverythingRunning() {
  return components.value.every((i) => i.status === 'running')
}

function areBoxesChecked() {
  return components.value.some((i) => {
    if (!i.enabled) return false
    if (i.serviceName === 'llamacpp-backend') {
      if (backendServices.llamaCppBuildVariant === 'standard') {
        if (!llamacppStandardRowIsSetUp(i)) return true
        return i.status !== 'running'
      }
      if (!(i.llamaCppPhisonArtifactReady ?? false)) return true
      return i.status !== 'running'
    }
    return i.status !== 'running'
  })
}

function convertVisibility(shouldBeVisible: boolean) {
  if (shouldBeVisible) {
    return 'visible'
  } else {
    return 'hidden'
  }
}

function showErrorDetails(serviceName: BackendServiceName) {
  const errorDetails = backendServices.getServiceErrorDetails(serviceName)
  selectedServiceName.value = serviceName
  selectedErrorDetails.value = errorDetails
  errorModalOpen.value = true
}

function closeErrorModal() {
  errorModalOpen.value = false
  selectedServiceName.value = ''
  selectedErrorDetails.value = null
}

// Format version string for display
function formatVersion(
  version: { version?: string; releaseTag?: string } | null | undefined,
): string {
  if (!version) return '-'
  if (version.releaseTag && version.version) {
    return `${version.releaseTag} / ${version.version}`
  }
  return version.version || '-'
}

// Format installed version for display
function formatInstalledVersion(serviceName: BackendServiceName): string {
  const versionState = backendServices.versionState[serviceName]
  if (versionState.installed) {
    return formatVersion(versionState.installed)
  }
  return '-'
}

// Check if installed version matches target version (up to date)
function isVersionUpToDate(serviceName: BackendServiceName): boolean {
  // AI backend doesn't have version tracking
  if (serviceName === 'ai-backend') return true
  const versionState = backendServices.versionState[serviceName]
  if (!versionState.target || !versionState.installed) return false
  return !hasVersionChange(serviceName)
}

// Get the effective target version (what will be installed)
function getEffectiveTarget(
  serviceName: BackendServiceName,
): { version?: string; releaseTag?: string } | undefined {
  const vs = backendServices.versionState[serviceName]
  return vs.uiOverride ?? vs.target
}

// Check if user has set a custom override
function hasUserOverride(serviceName: BackendServiceName): boolean {
  return !!backendServices.versionState[serviceName].uiOverride
}

// Check if official target is newer than user override
function hasNewerSupportedVersion(serviceName: BackendServiceName): boolean {
  const vs = backendServices.versionState[serviceName]
  if (!vs.uiOverride || !vs.target) return false

  const override = normalizeVersionForComparison(serviceName, vs.uiOverride.version || '')
  const target = normalizeVersionForComparison(serviceName, vs.target.version || '')

  return compareVersions(target, override) > 0
}

// Normalize version for comparison (strips subversion for OpenVINO)
// OpenVINO versions: 2025.4.0.0rc3 -> 2025.4.0 (only compare first 3 parts)
function normalizeVersionForComparison(serviceName: BackendServiceName, version: string): string {
  if (serviceName === 'openvino-backend') {
    // Extract first 3 version components (YYYY.major.minor)
    const parts = version.split('.')
    return parts.slice(0, 3).join('.')
  }
  return version
}

// Check if there's any version change pending (installed differs from effective target)
function hasVersionChange(serviceName: BackendServiceName): boolean {
  // AI backend doesn't have version tracking
  if (serviceName === 'ai-backend') return false

  const versionState = backendServices.versionState[serviceName]
  const effectiveTarget = getEffectiveTarget(serviceName)
  if (!effectiveTarget || !versionState.installed) return false

  // Normalize versions for comparison (handles OpenVINO subversions)
  const installedNorm = normalizeVersionForComparison(
    serviceName,
    versionState.installed.version || '',
  )
  const targetNorm = normalizeVersionForComparison(serviceName, effectiveTarget.version || '')

  return installedNorm !== targetNorm
}

// Compare versions to determine if it's an upgrade or downgrade
// Returns true for upgrade, false for downgrade, null if can't determine
function isUpgrade(serviceName: BackendServiceName): boolean | null {
  const versionState = backendServices.versionState[serviceName]
  const effectiveTarget = getEffectiveTarget(serviceName)
  if (!effectiveTarget?.version || !versionState.installed?.version) return null

  // Normalize versions for comparison (handles OpenVINO subversions)
  const installed = normalizeVersionForComparison(serviceName, versionState.installed.version)
  const target = normalizeVersionForComparison(serviceName, effectiveTarget.version)

  // Numeric segment comparison for proper version ordering
  if (compareVersions(installed, target) < 0) return true
  if (compareVersions(installed, target) > 0) return false
  return null
}

// Get appropriate icon: ↑ for upgrade, ↓ for downgrade
function getVersionChangeIcon(serviceName: BackendServiceName): string {
  const upgrading = isUpgrade(serviceName)
  if (upgrading === true) return '↑'
  if (upgrading === false) return '↓'
  return '⚠'
}

// Get appropriate class: green for upgrade, amber for downgrade
function getVersionChangeClass(serviceName: BackendServiceName): string {
  const upgrading = isUpgrade(serviceName)
  if (upgrading === true) return 'text-green-500'
  return 'text-amber-500'
}

// Format official target version for display
function formatOfficialTarget(serviceName: BackendServiceName): string {
  const versionState = backendServices.versionState[serviceName]
  if (versionState.target) {
    return formatVersion(versionState.target)
  }
  return '-'
}

// Format user override version for display
function formatUserOverride(serviceName: BackendServiceName): string {
  const versionState = backendServices.versionState[serviceName]
  if (versionState.uiOverride) {
    return formatVersion(versionState.uiOverride)
  }
  return '-'
}

// Format effective target version for display
function formatEffectiveTarget(serviceName: BackendServiceName): string {
  const effectiveTarget = getEffectiveTarget(serviceName)
  return formatVersion(effectiveTarget)
}

// Get CSS class for version status
function getVersionStatusClass(serviceName: BackendServiceName): string {
  if (hasVersionChange(serviceName) || hasNewerSupportedVersion(serviceName)) {
    return 'text-amber-500'
  }
  return 'text-foreground'
}

// Get CSS class for version status
function getUninstalledStatusClass(serviceName: BackendServiceName): string {
  if (hasVersionChange(serviceName) || hasNewerSupportedVersion(serviceName)) {
    return 'text-amber-500'
  }
  return 'text-muted-foreground'
}
</script>

<style>
ul {
  list-style-type: disc;
  padding-left: 20px;
}

.hover-box {
  position: absolute;
  background-color: rgba(90, 90, 90, 0.91);
  border: 1px solid #000000;
  padding: 10px;
  border-radius: 10px;
  z-index: 1;
}

table {
  border-collapse: separate;
  border-spacing: 10px;
}
</style>
