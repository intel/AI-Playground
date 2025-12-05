import { defineStore } from 'pinia'
import { ref } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import { useDialogStore } from './dialogs'
import { useGlobalSetup } from './globalSetup'
import { useI18N } from './i18n'
import * as toast from '@/assets/js/toast'

const WHISPER_MODEL_NAME = 'OpenVINO/whisper-large-v3-int4-ov'

export const useSpeechToText = defineStore(
  'speechToText',
  () => {
    const enabled = ref(false)
    const backendServices = useBackendServices()
    const models = useModels()
    const dialogStore = useDialogStore()
    const globalSetup = useGlobalSetup()
    const i18nState = useI18N().state

    /**
     * Ensures the transcription server is running when STT is enabled.
     * This method checks if the server is already running and starts it if needed.
     */
    async function ensureTranscriptionServerRunning(): Promise<void> {
      if (!enabled.value) return

      const openVinoService = backendServices.info.find(
        (s) => s.serviceName === 'openvino-backend',
      )

      // Only start if OVMS is set up
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
     * This should be called once during app initialization.
     */
    async function initialize(): Promise<void> {
      await ensureTranscriptionServerRunning()
    }

    /**
     * Toggle Speech To Text functionality.
     * Handles all validation, installation checks, model downloads, and server management.
     *
     * @param isEnabled - Whether to enable or disable STT
     * @returns Promise that resolves when the toggle operation is complete
     */
    async function toggle(isEnabled: boolean): Promise<void> {
      if (isEnabled) {
        // Check if OpenVINO backend is installed
        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService || !openVinoService.isSetUp) {
          // Show warning dialog to install OVMS
          dialogStore.showWarningDialog(
              'OpenVINO backend is required for Speech To Text. Please install it first.',
            () => {
              globalSetup.loadingState = 'manageInstallations'
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
      toggle,
      initialize,
      ensureTranscriptionServerRunning,
    }
  },
  {
    persist: {
      pick: ['enabled'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSpeechToText, import.meta.hot))
}
