<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- Backdrop -->
    <div class="absolute inset-0 bg-black/60" @click="closeModal"></div>

    <!-- Modal -->
    <div
      class="relative bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[80vh] overflow-hidden"
    >
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-gray-700">
        <h2 class="text-xl font-semibold text-white">
          {{ i18nState.ERR_INSTALL_DETAILS_TITLE }} - {{ serviceName }}
        </h2>
        <button @click="closeModal" class="text-gray-400 hover:text-white transition-colors">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 18L18 6M6 6l12 12"
            ></path>
          </svg>
        </button>
      </div>

      <!-- Content -->
      <div class="p-4 overflow-y-auto max-h-[calc(80vh-120px)]">
        <div v-if="errorDetails" class="space-y-4">
          <!-- Command Info -->
          <div class="bg-gray-900 rounded-lg p-4">
            <h3 class="text-lg font-medium text-white mb-2">{{ i18nState.ERR_FAILED_COMMAND }}</h3>
            <div class="bg-black rounded p-3 font-mono text-sm">
              <span class="text-green-400">$</span>
              <span class="text-white ms-2">{{ errorDetails.command }}</span>
            </div>
          </div>

          <!-- Execution Info -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="bg-gray-900 rounded-lg p-4">
              <h4 class="text-sm font-medium text-gray-300 mb-1">{{ i18nState.ERR_EXIT_CODE }}</h4>
              <span class="text-red-400 font-mono text-lg">{{ errorDetails.exitCode }}</span>
            </div>
            <div class="bg-gray-900 rounded-lg p-4">
              <h4 class="text-sm font-medium text-gray-300 mb-1">{{ i18nState.ERR_DURATION }}</h4>
              <span class="text-primary font-mono text-lg">{{
                formatDuration(errorDetails.duration)
              }}</span>
            </div>
            <div class="bg-gray-900 rounded-lg p-4">
              <h4 class="text-sm font-medium text-gray-300 mb-1">{{ i18nState.ERR_TIMESTAMP }}</h4>
              <span class="text-yellow-400 font-mono text-sm">{{
                formatTimestamp(errorDetails.timestamp)
              }}</span>
            </div>
          </div>

          <!-- Standard Error -->
          <div v-if="errorDetails.stderr" class="bg-gray-900 rounded-lg p-4">
            <h3 class="text-lg font-medium text-red-400 mb-2">{{ i18nState.ERR_STDERR }}</h3>
            <div class="bg-black rounded p-3 max-h-64 overflow-y-auto">
              <pre class="text-red-300 text-sm whitespace-pre-wrap">{{ errorDetails.stderr }}</pre>
            </div>
          </div>

          <!-- Standard Output -->
          <div v-if="errorDetails.stdout" class="bg-gray-900 rounded-lg p-4">
            <h3 class="text-lg font-medium text-primary mb-2">{{ i18nState.ERR_STDOUT }}</h3>
            <div class="bg-black rounded p-3 max-h-64 overflow-y-auto">
              <pre class="text-primary/80 text-sm whitespace-pre-wrap">{{
                errorDetails.stdout
              }}</pre>
            </div>
          </div>

          <!-- Pip Freeze Output -->
          <div v-if="errorDetails.pipFreezeOutput" class="bg-gray-900 rounded-lg p-4">
            <h3 class="text-lg font-medium text-primary mb-2">{{ i18nState.ERR_PIP_FREEZE }}</h3>
            <div class="bg-black rounded p-3 max-h-64 overflow-y-auto">
              <pre class="text-primary/80 text-sm whitespace-pre-wrap">{{
                errorDetails.pipFreezeOutput
              }}</pre>
            </div>
          </div>

          <!-- Troubleshooting Tips -->
          <div class="bg-yellow-900 bg-opacity-30 border border-yellow-600 rounded-lg p-4">
            <h3 class="text-lg font-medium text-yellow-400 mb-2">
              {{ i18nState.ERR_TIPS_HEADER }}
            </h3>
            <ul class="text-yellow-200 text-sm space-y-1 list-disc list-inside">
              <li>{{ i18nState.ERR_TIP_1 }}</li>
              <li>{{ i18nState.ERR_TIP_2 }}</li>
              <li>{{ i18nState.ERR_TIP_3 }}</li>
              <li>{{ i18nState.ERR_TIP_4 }}</li>
            </ul>
          </div>
        </div>

        <div v-else class="text-center text-gray-400 py-8">
          <p>{{ i18nState.ERR_NO_DETAILS }}</p>
        </div>
      </div>

      <!-- Footer -->
      <div class="flex justify-end p-2 border-t border-gray-700">
        <button
          @click="copyErrorDetails"
          class="me-3 px-4 py-2 bg-primary hover:bg-primary/80 text-primary-foreground rounded transition-colors"
        >
          {{ i18nState.ERR_COPY_DETAILS }}
        </button>
        <button
          @click="closeModal"
          class="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded transition-colors"
        >
          {{ i18nState.COM_CLOSE }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as toast from '@/assets/js/toast.ts'
import { useI18N } from '@/assets/js/store/i18n'

interface ErrorDetails {
  command?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  timestamp?: string
  duration?: number
  pipFreezeOutput?: string
}

interface Props {
  isOpen: boolean
  serviceName: string
  errorDetails: ErrorDetails | null
}

interface Emits {
  (e: 'close'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()
const i18nState = useI18N().state

const closeModal = () => {
  emit('close')
}

const formatDuration = (duration?: number): string => {
  if (!duration) return i18nState.ERR_UNKNOWN
  if (duration < 1000) return `${duration}ms`
  return `${(duration / 1000).toFixed(1)}s`
}

const formatTimestamp = (timestamp?: string): string => {
  if (!timestamp) return i18nState.ERR_UNKNOWN
  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return timestamp
  }
}

const copyErrorDetails = async () => {
  if (!props.errorDetails) return

  const unknown = i18nState.ERR_UNKNOWN
  const details = [
    `Service: ${props.serviceName}`,
    `Command: ${props.errorDetails.command || unknown}`,
    `Exit Code: ${props.errorDetails.exitCode || unknown}`,
    `Duration: ${formatDuration(props.errorDetails.duration)}`,
    `Timestamp: ${formatTimestamp(props.errorDetails.timestamp)}`,
    '',
    'Standard Error:',
    props.errorDetails.stderr || 'No stderr output',
    '',
    'Standard Output:',
    props.errorDetails.stdout || 'No stdout output',
    '',
    'Python Environment (pip freeze):',
    props.errorDetails.pipFreezeOutput || 'No pip freeze output available',
  ].join('\n')

  try {
    await navigator.clipboard.writeText(details)
    toast.success(i18nState.ERR_COPIED_OK)
  } catch (err) {
    console.error('Failed to copy error details:', err)
    toast.error(i18nState.ERR_COPY_FAILED)
  }
}
</script>

<style scoped>
/* Custom scrollbar for better appearance */
.overflow-y-auto::-webkit-scrollbar {
  width: 8px;
}

.overflow-y-auto::-webkit-scrollbar-track {
  background: #374151;
  border-radius: 4px;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
  background: #6b7280;
  border-radius: 4px;
}

.overflow-y-auto::-webkit-scrollbar-thumb:hover {
  background: #9ca3af;
}
</style>
