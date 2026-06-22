import { defineStore } from 'pinia'
import { ref } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import { useDialogStore } from './dialogs'
import * as toast from '@/assets/js/toast'
import { useSetupWizard } from './setupWizard'
import { useProductMode } from './productMode'

export const WHISPER_MODEL_NAME = 'OpenVINO/whisper-base-int8-ov'

/**
 * Resolved transcription endpoint configuration consumed by the shared
 * `transcribeAudio` helper. `baseURL` is an OpenAI-compatible base (ending in
 * `/v3` for OVMS or `/v1` for a generic whisper-server); `model` is the model
 * id to request; `apiKey` may be empty for local servers.
 */
export type TranscriptionEndpoint = {
  baseURL: string
  model: string
  apiKey: string
}

/**
 * Configurable fallback transcription endpoint. Used when the OVMS Whisper
 * server is not available (e.g. on macOS, where OVMS does not run). Points at
 * any OpenAI-compatible transcription server — e.g. a local whisper.cpp
 * `whisper-server` started with `--inference-path "/v1/audio/transcriptions"`.
 */
export type SttFallbackConfig = {
  enabled: boolean
  baseUrl: string
  model: string
  apiKey: string
}

export const useSpeechToText = defineStore(
  'speechToText',
  () => {
    const enabled = ref(false)
    const initializing = ref(false)
    const backendServices = useBackendServices()
    const models = useModels()
    const dialogStore = useDialogStore()
    const setupWizard = useSetupWizard()
    const productMode = useProductMode()

    /**
     * App-wide fallback transcription endpoint. Shared by both the Home Agent
     * voice-message pipeline and the regular mic-STT path so transcription
     * works even without OVMS installed.
     */
    const fallback = ref<SttFallbackConfig>({
      enabled: false,
      baseUrl: '',
      model: 'whisper-1',
      apiKey: '',
    })

    /** True when a usable fallback endpoint is configured. */
    function hasFallback(): boolean {
      return fallback.value.enabled && fallback.value.baseUrl.trim().length > 0
    }

    /**
     * Resolve which transcription endpoint to use. Prefers the OVMS Whisper
     * server when it is running, otherwise falls back to the configured
     * OpenAI-compatible endpoint. Returns `null` when neither is available.
     */
    async function resolveTranscription(): Promise<TranscriptionEndpoint | null> {
      try {
        const ovmsUrl = await backendServices.getTranscriptionServerUrl()
        if (ovmsUrl) {
          return {
            baseURL: ovmsUrl,
            model: WHISPER_MODEL_NAME.split('/').join('---'),
            apiKey: '',
          }
        }
      } catch (error) {
        console.error('Failed to resolve OVMS transcription server URL:', error)
      }

      if (hasFallback()) {
        return {
          baseURL: fallback.value.baseUrl.trim(),
          model: fallback.value.model.trim() || 'whisper-1',
          apiKey: fallback.value.apiKey,
        }
      }

      return null
    }
    /**
     * Ensures the transcription server is running when STT is enabled.
     * This method checks if the server is already running and starts it if needed.
     * Unlike initialize(), this method does NOT auto-disable STT on failure.
     */
    async function ensureTranscriptionServerRunning(): Promise<void> {
      if (!enabled.value) return

      const openVinoService = backendServices.info.find((s) => s.serviceName === 'openvino-backend')

      // Only start if OVMS is set up. When OVMS is unavailable but a fallback
      // endpoint is configured, transcription is served by the fallback so
      // there is nothing to start here.
      if (!openVinoService?.isSetUp) return

      const modelExists = await models.checkTranscriptionModelExists(WHISPER_MODEL_NAME)
      if (!modelExists) return

      try {
        const url = await backendServices.getTranscriptionServerUrl()
        if (!url) {
          // Server not running, start it
          await backendServices.startTranscriptionServer(WHISPER_MODEL_NAME)
        }
      } catch (error) {
        console.error('Failed to ensure transcription server is running:', error)
      }
    }

    /**
     * Initialize the transcription server on app startup if STT is enabled.
     * This validates all prerequisites and auto-disables STT if they are not met,
     * providing user feedback via toast notifications.
     *
     * This should be called once during app initialization after backends are started.
     */
    async function initialize(): Promise<void> {
      if (productMode.isNvidiaModeSelected) {
        enabled.value = false
        return
      }

      if (!enabled.value) return

      initializing.value = true

      try {
        // Check OpenVINO backend setup
        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService?.isSetUp) {
          // OVMS not installed: keep STT enabled if a fallback endpoint is
          // configured (e.g. on macOS where OVMS does not run), otherwise
          // disable it as before.
          if (hasFallback()) return
          enabled.value = false
          toast.warning('Speech To Text disabled: OpenVINO backend is not installed')
          return
        }

        // Check model exists
        const modelExists = await models.checkTranscriptionModelExists(WHISPER_MODEL_NAME)
        if (!modelExists) {
          enabled.value = false
          toast.warning('Speech To Text disabled: Whisper model not found')
          return
        }

        // Check if server is already running
        const url = await backendServices.getTranscriptionServerUrl()
        if (!url) {
          // Start transcription server
          await backendServices.startTranscriptionServer(WHISPER_MODEL_NAME)
        }
      } catch (error) {
        enabled.value = false
        const errorMessage = error instanceof Error ? error.message : String(error)
        toast.error(`Speech To Text disabled: ${errorMessage}`)
      } finally {
        initializing.value = false
      }
    }

    /**
     * Toggle Speech To Text functionality.
     * Handles all validation, installation checks, model downloads, and server management.
     *
     * @param isEnabled - Whether to enable or disable STT
     * @returns Promise that resolves when the toggle operation is complete
     */
    async function toggle(isEnabled: boolean): Promise<void> {
      if (isEnabled && productMode.isNvidiaModeSelected) {
        return
      }

      if (isEnabled) {
        // Check if OpenVINO backend is installed
        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService || !openVinoService.isSetUp) {
          // Allow enabling STT against the configured fallback endpoint when
          // OVMS is not installed (e.g. macOS dev). Otherwise require OVMS.
          if (hasFallback()) {
            enabled.value = true
            toast.success('Speech To Text enabled (using fallback transcription endpoint)')
            return
          }
          dialogStore.showWarningDialog(
            'OpenVINO backend is required for Speech To Text. Please install it first, or configure a fallback transcription endpoint in Settings.',
            () => {
              setupWizard.openWizard()
            },
          )
          return
        }

        // Check if whisper model exists
        const modelExists = await models.checkTranscriptionModelExists(WHISPER_MODEL_NAME)

        if (!modelExists) {
          // Show download dialog
          const missingModels = await models.getMissingTranscriptionModel(WHISPER_MODEL_NAME)
          if (missingModels.length > 0) {
            dialogStore.showDownloadDialog(
              missingModels,
              async () => {
                // Model downloaded, start transcription server
                try {
                  await backendServices.startTranscriptionServer(WHISPER_MODEL_NAME)
                  enabled.value = true
                  toast.success('Speech To Text enabled')
                } catch (error) {
                  toast.error(`Failed to start transcription server: ${error}`)
                }
              },
              () => {
                // Download failed or cancelled
                toast.warning('Speech To Text requires the whisper model')
              },
            )
            return
          }
        }

        // All requirements met, start transcription server
        try {
          await backendServices.startTranscriptionServer(WHISPER_MODEL_NAME)
          enabled.value = true
          toast.success('Speech To Text enabled')
        } catch (error) {
          toast.error(`Failed to start transcription server: ${error}`)
        }
      } else {
        // Disable Speech To Text
        try {
          await backendServices.stopTranscriptionServer()
          enabled.value = false
          toast.success('Speech To Text disabled')
        } catch (error) {
          toast.error(`Failed to stop transcription server: ${error}`)
        }
      }
    }

    return {
      enabled,
      initializing,
      fallback,
      hasFallback,
      resolveTranscription,
      toggle,
      initialize,
      ensureTranscriptionServerRunning,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['enabled', 'fallback'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSpeechToText, import.meta.hot))
}
