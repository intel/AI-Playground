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
import { synthesizeSpeech, bytesToBlobUrl } from '@/lib/synthesizeSpeech'

export const SPEECHT5_MODEL_NAME = 'microsoft/speecht5_tts'

/**
 * Resolved text-to-speech endpoint configuration consumed by the shared
 * `synthesizeSpeech` helper. `baseURL` is an OpenAI-compatible base (ending in
 * `/v3` for OVMS or `/v1` for a generic server); `model` is the model id to
 * request; `voice` may be empty when the server has a single default voice;
 * `apiKey` may be empty for local servers.
 */
export type SpeechEndpoint = {
  baseURL: string
  model: string
  voice: string
  apiKey: string
}

/**
 * Configurable fallback text-to-speech endpoint. Used when the OVMS
 * text2speech server is not available (e.g. on macOS, where OVMS does not
 * run). Points at any OpenAI-compatible `/v1/audio/speech` server.
 */
export type TtsFallbackConfig = {
  enabled: boolean
  baseUrl: string
  model: string
  voice: string
  apiKey: string
}

export const useTextToSpeech = defineStore(
  'textToSpeech',
  () => {
    const enabled = ref(false)
    const initializing = ref(false)
    // When true, the desktop app auto-plays replies (and the Home Agent sends a
    // voice reply) whenever the user's input came from speech.
    const autoSpeakOnVoiceInput = ref(true)
    const backendServices = useBackendServices()
    const models = useModels()
    const dialogStore = useDialogStore()
    const setupWizard = useSetupWizard()
    const productMode = useProductMode()

    /**
     * App-wide fallback speech endpoint. Shared by the desktop auto-play path
     * and the Home Agent voice-reply pipeline so TTS works even without OVMS.
     */
    const fallback = ref<TtsFallbackConfig>({
      enabled: false,
      baseUrl: '',
      model: 'tts-1',
      voice: '',
      apiKey: '',
    })

    // Playback state for the desktop UI.
    const isSpeaking = ref(false)
    const speakingMessageId = ref<string | null>(null)
    // Transient flag: set when a mic transcript arrives, consumed on reply
    // completion so we only auto-speak turns that originated from speech.
    const pendingVoiceTurn = ref(false)

    let currentAudio: HTMLAudioElement | null = null
    let currentObjectUrl: string | null = null

    /** True when a usable fallback endpoint is configured. */
    function hasFallback(): boolean {
      return fallback.value.enabled && fallback.value.baseUrl.trim().length > 0
    }

    /**
     * Resolve which speech endpoint to use. Prefers the OVMS text2speech server
     * when it is running, otherwise falls back to the configured
     * OpenAI-compatible endpoint. Returns `null` when neither is available.
     */
    async function resolveSpeech(): Promise<SpeechEndpoint | null> {
      try {
        const ovmsUrl = await backendServices.getSpeechServerUrl()
        if (ovmsUrl) {
          return {
            baseURL: ovmsUrl,
            model: SPEECHT5_MODEL_NAME.split('/').join('---'),
            voice: '',
            apiKey: '',
          }
        }
      } catch (error) {
        console.error('Failed to resolve OVMS speech server URL:', error)
      }

      if (hasFallback()) {
        return {
          baseURL: fallback.value.baseUrl.trim(),
          model: fallback.value.model.trim() || 'tts-1',
          voice: fallback.value.voice.trim(),
          apiKey: fallback.value.apiKey,
        }
      }

      return null
    }

    /**
     * Ensures the speech server is running when TTS is enabled.
     * Does NOT auto-disable TTS on failure.
     */
    async function ensureSpeechServerRunning(): Promise<void> {
      if (!enabled.value) return

      const openVinoService = backendServices.info.find((s) => s.serviceName === 'openvino-backend')

      // Only start if OVMS is set up. When OVMS is unavailable but a fallback
      // endpoint is configured, synthesis is served by the fallback so there
      // is nothing to start here.
      if (!openVinoService?.isSetUp) return

      const modelExists = await models.checkSpeechModelExists(SPEECHT5_MODEL_NAME)
      if (!modelExists) return

      try {
        const url = await backendServices.getSpeechServerUrl()
        if (!url) {
          await backendServices.startSpeechServer(SPEECHT5_MODEL_NAME)
        }
      } catch (error) {
        console.error('Failed to ensure speech server is running:', error)
      }
    }

    /**
     * Initialize the speech server on app startup if TTS is enabled.
     * Validates prerequisites and auto-disables TTS if they are not met.
     */
    async function initialize(): Promise<void> {
      if (productMode.isNvidiaModeSelected) {
        enabled.value = false
        return
      }

      if (!enabled.value) return

      initializing.value = true

      try {
        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService?.isSetUp) {
          // OVMS not installed: keep TTS enabled if a fallback endpoint is
          // configured (e.g. on macOS), otherwise disable it.
          if (hasFallback()) return
          enabled.value = false
          toast.warning('Text To Speech disabled: OpenVINO backend is not installed')
          return
        }

        const modelExists = await models.checkSpeechModelExists(SPEECHT5_MODEL_NAME)
        if (!modelExists) {
          enabled.value = false
          toast.warning('Text To Speech disabled: speech model not found')
          return
        }

        const url = await backendServices.getSpeechServerUrl()
        if (!url) {
          await backendServices.startSpeechServer(SPEECHT5_MODEL_NAME)
        }
      } catch (error) {
        enabled.value = false
        const errorMessage = error instanceof Error ? error.message : String(error)
        toast.error(`Text To Speech disabled: ${errorMessage}`)
      } finally {
        initializing.value = false
      }
    }

    /**
     * Toggle Text To Speech functionality.
     * Handles validation, installation checks, model downloads, and server management.
     */
    async function toggle(isEnabled: boolean): Promise<void> {
      if (isEnabled && productMode.isNvidiaModeSelected) {
        return
      }

      if (isEnabled) {
        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService || !openVinoService.isSetUp) {
          // Allow enabling TTS against the configured fallback endpoint when
          // OVMS is not installed (e.g. macOS dev). Otherwise require OVMS.
          if (hasFallback()) {
            enabled.value = true
            toast.success('Text To Speech enabled (using fallback speech endpoint)')
            return
          }
          dialogStore.showWarningDialog(
            'OpenVINO backend is required for Text To Speech. Please install it first, or configure a fallback speech endpoint in Settings.',
            () => {
              setupWizard.openWizard()
            },
          )
          return
        }

        const modelExists = await models.checkSpeechModelExists(SPEECHT5_MODEL_NAME)

        if (!modelExists) {
          const missingModels = await models.getMissingSpeechModel(SPEECHT5_MODEL_NAME)
          if (missingModels.length > 0) {
            dialogStore.showDownloadDialog(
              missingModels,
              async () => {
                try {
                  await backendServices.startSpeechServer(SPEECHT5_MODEL_NAME)
                  enabled.value = true
                  toast.success('Text To Speech enabled')
                } catch (error) {
                  toast.error(`Failed to start speech server: ${error}`)
                }
              },
              () => {
                toast.warning('Text To Speech requires the speech model')
              },
            )
            return
          }
        }

        try {
          await backendServices.startSpeechServer(SPEECHT5_MODEL_NAME)
          enabled.value = true
          toast.success('Text To Speech enabled')
        } catch (error) {
          toast.error(`Failed to start speech server: ${error}`)
        }
      } else {
        try {
          await backendServices.stopSpeechServer()
          enabled.value = false
          toast.success('Text To Speech disabled')
        } catch (error) {
          toast.error(`Failed to stop speech server: ${error}`)
        }
      }
    }

    /** Stop any in-progress playback and release the object URL. */
    function stopSpeaking(): void {
      if (currentAudio) {
        currentAudio.pause()
        currentAudio.src = ''
        currentAudio = null
      }
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl)
        currentObjectUrl = null
      }
      isSpeaking.value = false
      speakingMessageId.value = null
    }

    /**
     * Synthesize `text` and play it back in the desktop app. `id` ties the
     * playback to a specific chat message so the UI can show a stop affordance.
     */
    async function speak(text: string, id?: string): Promise<void> {
      const trimmed = (text ?? '').trim()
      if (!trimmed) return

      stopSpeaking()

      const endpoint = await resolveSpeech()
      if (!endpoint) {
        toast.warning('Text To Speech is not available (no OVMS server or fallback configured)')
        return
      }

      try {
        isSpeaking.value = true
        speakingMessageId.value = id ?? null

        const { bytes, mediaType } = await synthesizeSpeech(trimmed, endpoint)
        const url = bytesToBlobUrl(bytes, mediaType)
        currentObjectUrl = url

        const audio = new Audio(url)
        currentAudio = audio
        audio.onended = () => stopSpeaking()
        audio.onerror = () => stopSpeaking()
        await audio.play()
      } catch (error) {
        console.error('Failed to synthesize speech:', error)
        toast.error(`Failed to play speech: ${error instanceof Error ? error.message : error}`)
        stopSpeaking()
      }
    }

    return {
      enabled,
      initializing,
      autoSpeakOnVoiceInput,
      fallback,
      isSpeaking,
      speakingMessageId,
      pendingVoiceTurn,
      hasFallback,
      resolveSpeech,
      toggle,
      initialize,
      ensureSpeechServerRunning,
      speak,
      stopSpeaking,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['enabled', 'autoSpeakOnVoiceInput', 'fallback'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTextToSpeech, import.meta.hot))
}
