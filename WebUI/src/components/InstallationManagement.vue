<template>
  <div class="z-10 text-foreground rounded-xl bg-background/70 border border-border">
    <div class="px-20 py-5 max-w-5xl">
      <h1 class="text-center py-1 px-4 rounded-sm text-4xl">
        {{ languages.BACKEND_MANAGE }}
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
                  v-if="component.status !== 'running' && !component.isLoading"
                  class="mx-auto"
                  :model-value="component.enabled"
                  @update:model-value="
                    (value: boolean | 'indeterminate') => {
                      if (value === true) {
                        toBeInstalledComponents.add(component.serviceName)
                      } else {
                        toBeInstalledComponents.delete(component.serviceName)
                      }
                    }
                  "
                  :disabled="component.isRequired"
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
              <td :style="{ color: mapStatusToColor(component.status) }" class="">
                <div class="flex items-center gap-2">
                  <span>{{ mapToDisplayStatus(component.status) }}</span>
                  <button
                    v-if="
                      component.status === 'failed' || component.status === 'installationFailed'
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
                  v-if="component.isLoading"
                  class="svg-icon i-loading flex-none w-5 h-5"
                ></span>
                <button
                  v-else-if="component.status === 'notInstalled' && !component.isSetUp"
                  @click="() => installBackend(component.serviceName)"
                  :disabled="!component.enabled || isSomethingLoading()"
                  class="bg-primary py-1 px-4 rounded"
                >
                  {{ languages.COM_INSTALL }}
                </button>
                <button
                  v-else-if="
                    component.status === 'failed' || component.status === 'installationFailed'
                  "
                  @click="() => repairBackend(component.serviceName)"
                  :disabled="!component.enabled || isSomethingLoading()"
                  class="bg-primary py-1 px-4 rounded"
                >
                  {{ languages.COM_REPAIR }}
                </button>
                <button
                  v-else-if="component.status === 'running'"
                  @click="() => restartBackend(component.serviceName)"
                  :disabled="isSomethingLoading()"
                  class="bg-primary py-1 px-4 rounded"
                >
                  {{ languages.COM_RESTART }}
                </button>
                <button
                  v-else-if="component.status === 'stopped' || component.status === 'notYetStarted'"
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
          :style="{ visibility: convertVisibility(somethingChanged) }"
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
import { mapServiceNameToDisplayName, mapStatusToColor, mapToDisplayStatus } from '@/lib/utils.ts'
import * as toast from '@/assets/js/toast.ts'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import LanguageSelector from '@/components/LanguageSelector.vue'
import BackendOptions from '@/components/BackendOptions.vue'
import ErrorDetailsModal from '@/components/ErrorDetailsModal.vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import type { ErrorDetails } from '../../electron/subprocesses/service'

const emits = defineEmits<{
  (e: 'close'): void
}>()

type ExtendedApiServiceInformation = ApiServiceInformation & {
  enabled: boolean
  isLoading: boolean
}

const backendServices = useBackendServices()
const globalSetup = useGlobalSetup()

// App version for AI Backend display
const appVersion = computed(() => globalSetup.state.version)

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

const components = computed(() => {
  return backendServices.info.map((item) => ({
    enabled:
      alreadyInstalledOrRequiredComponents.value.has(item.serviceName) ||
      toBeInstalledComponents.value.has(item.serviceName),
    isLoading: loadingComponents.value.has(item.serviceName),
    ...item,
  }))
})

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
  toBeInstalledQueue = components.value.filter(
    (item) =>
      item.enabled &&
      (item.status === 'notInstalled' ||
        item.status === 'failed' ||
        item.status === 'installationFailed'),
  )
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
  return components.value.some((i) => i.status !== 'running' && i.enabled)
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

  const override = vs.uiOverride.version || ''
  const target = vs.target.version || ''

  return target > override
}

// Check if there's any version change pending (installed differs from effective target)
function hasVersionChange(serviceName: BackendServiceName): boolean {
  // AI backend doesn't have version tracking
  if (serviceName === 'ai-backend') return false

  const versionState = backendServices.versionState[serviceName]
  const effectiveTarget = getEffectiveTarget(serviceName)
  if (!effectiveTarget || !versionState.installed) return false

  // For Ollama, compare both version and releaseTag
  if (serviceName === 'ollama-backend') {
    return (
      versionState.installed.version !== effectiveTarget.version ||
      versionState.installed.releaseTag !== effectiveTarget.releaseTag
    )
  }

  // For other backends, compare version only
  return versionState.installed.version !== effectiveTarget.version
}

// Compare versions to determine if it's an upgrade or downgrade
// Returns true for upgrade, false for downgrade, null if can't determine
function isUpgrade(serviceName: BackendServiceName): boolean | null {
  const versionState = backendServices.versionState[serviceName]
  const effectiveTarget = getEffectiveTarget(serviceName)
  if (!effectiveTarget?.version || !versionState.installed?.version) return null

  const installed = versionState.installed.version
  const target = effectiveTarget.version

  // Simple string comparison - works for semver-like versions
  // For more complex versioning, this could be enhanced
  if (installed < target) return true
  if (installed > target) return false
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
  if (upgrading === true) return 'text-amber-500'
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
