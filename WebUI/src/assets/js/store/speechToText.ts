import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import { useDialogStore } from './dialogs'
import * as toast from '@/assets/js/toast'
import { useSetupWizard } from './setupWizard'
import { useProductMode } from './productMode'
import {
  DEFAULT_WHISPER_OVMS_MODEL,
  DEFAULT_WHISPER_STANDALONE_MODEL,
  type WhisperOvmsModel,
  type WhisperStandaloneModel,
} from '@/assets/js/whisperConstants'

/** Which engine backs Speech To Text.
 *  - `whisper`: OpenVINO OVMS Whisper server — needs OpenVINO (non-NVIDIA).
 *  - `standalone`: the torch Whisper sidecar (whisper-backend) — works in every mode
 *    (incl. NVIDIA) when its optional backend is installed.
 *  - `external`: an OpenAI-compatible endpoint configured in App Settings — works in
 *    every mode when enabled. */
export type SttEngine = 'whisper' | 'standalone' | 'external'

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
 * Outcome of readying an STT engine.
 *
 * `downloadPrompted` is true when getting ready required a user-facing model
 * download popup. Callers that were about to *start* something on the user's
 * behalf (the mic button) must treat that as "this click went to the download,
 * ask the user to click again": the click that opened the dialog is spent, and
 * silently starting a recording when the download finishes captures whatever
 * happens to be said next — which then gets transcribed as gibberish. Callers
 * that only transcribe already-captured audio (the transcribeAudio tool, the
 * Home Agent voice pipeline) can ignore it and proceed.
 */
export type SttReadyResult = { downloadPrompted: boolean }

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
    // Which engine the STT preset (and mic transcription) uses. Edited in SettingsStt.
    const selectedSttEngine = ref<SttEngine>('whisper')
    // Which model the standalone (torch) Whisper engine uses.
    const selectedStandaloneModel = ref<WhisperStandaloneModel>(DEFAULT_WHISPER_STANDALONE_MODEL)
    // Which model the OpenVINO (OVMS) Whisper engine serves. OVMS takes the repo id
    // per server launch, so switching this just restarts the transcription server.
    const selectedOvmsModel = ref<WhisperOvmsModel>(DEFAULT_WHISPER_OVMS_MODEL)
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

    /** Whether the OpenVINO Whisper engine can be offered: OpenVINO must be
     *  installable in this product mode (not NVIDIA) and set up. */
    const isWhisperAvailable = computed(() => {
      if (productMode.isNvidiaModeSelected) return false
      const ov = backendServices.info.find((s) => s.serviceName === 'openvino-backend')
      return ov?.isSetUp === true
    })

    /** Whether the external (fallback) transcription endpoint is configured/usable. */
    const isExternalAvailable = computed(() => hasFallback())

    /** Whether the standalone (torch) Whisper engine can be offered: its optional
     *  backend must be installed. Works in every product mode (incl. NVIDIA). */
    const isStandaloneAvailable = computed(() => {
      const svc = backendServices.info.find((s) => s.serviceName === 'whisper-backend')
      return svc?.isSetUp === true
    })

    // Installation alone is not enough to *prefer* standalone over a configured
    // fallback (CodeRabbit on 278): the sidecar can be set up without its model.
    const standaloneModelPresent = ref(false)
    async function refreshStandaloneModelPresent(): Promise<void> {
      if (!isStandaloneAvailable.value) {
        standaloneModelPresent.value = false
        return
      }
      try {
        standaloneModelPresent.value = await models.checkTranscriptionModelExists(
          selectedStandaloneModel.value,
        )
      } catch {
        standaloneModelPresent.value = false
      }
    }
    watch([isStandaloneAvailable, selectedStandaloneModel], () => {
      void refreshStandaloneModelPresent()
    })
    void refreshStandaloneModelPresent()

    /**
     * Whether speech-to-text is usable at all: OpenVINO Whisper (non-NVIDIA), the
     * standalone Whisper backend, or a configured external endpoint. Used to gate the
     * in-chat mic and the STT preset now that the old global STT enable toggle is gone.
     */
    const available = computed(
      () => isWhisperAvailable.value || isStandaloneAvailable.value || isExternalAvailable.value,
    )

    /** Engines the STT dropdown offers: Whisper (OpenVINO) only off NVIDIA;
     *  standalone always (its backend is installable in every mode); External only
     *  when its App Settings checkbox is ticked — that checkbox is what "adds an
     *  External endpoint engine to the Speech to Text preset", so an unticked box
     *  must not leave the engine listed (this matches how the TTS panel gates its
     *  own external engine on `textToSpeech.fallback.enabled`).
     *
     *  Gated on the checkbox alone, NOT on `hasFallback()`: the engine has to be
     *  selectable while the URL is still empty, since SettingsStt is where the
     *  user types it in. */
    const offeredSttEngines = computed<SttEngine[]>(() => {
      const list: SttEngine[] = []
      if (!productMode.isNvidiaModeSelected) list.push('whisper')
      list.push('standalone')
      if (fallback.value.enabled) list.push('external')
      return list
    })

    /** Best default engine: an installed one first (OpenVINO Whisper → standalone →
     *  external), and only when nothing is installed the highest-priority offered
     *  engine (so External is the default only if neither Whisper is available).
     *  The final 'external' is a last resort for the degenerate case where nothing
     *  is offered at all (NVIDIA mode, standalone feature off, checkbox unticked);
     *  SettingsStt then shows its "install a backend or enable an endpoint" hint. */
    const preferredSttEngine = computed<SttEngine>(() => {
      if (isWhisperAvailable.value) return 'whisper'
      if (isStandaloneAvailable.value && standaloneModelPresent.value) return 'standalone'
      if (isExternalAvailable.value) return 'external'
      if (isStandaloneAvailable.value) return 'standalone'
      return offeredSttEngines.value[0] ?? 'external'
    })

    /** Whether a given engine can actually serve a transcription right now. */
    function isEngineUsable(engine: SttEngine): boolean {
      if (engine === 'whisper') return isWhisperAvailable.value
      if (engine === 'standalone') return isStandaloneAvailable.value
      return isExternalAvailable.value
    }

    /**
     * The engine actually used for a transcription. The selection in SettingsStt is
     * a *preference*, and 'whisper' (OpenVINO) is offered in every non-NVIDIA mode
     * whether or not OVMS is installed — so a user whose only installed engine is
     * the standalone Whisper backend kept the persisted 'whisper' default and every
     * mic click failed with "OpenVINO backend is required" even though
     * speech-to-text was perfectly usable. Fall back to whatever is installed.
     */
    const effectiveSttEngine = computed<SttEngine>(() =>
      isEngineUsable(selectedSttEngine.value) ? selectedSttEngine.value : preferredSttEngine.value,
    )

    // Keep the selection valid for the current mode: when the chosen engine isn't
    // offered (e.g. the persisted 'whisper' default in NVIDIA mode), fall back to
    // the preferred engine. This drives every consumer (mic, tool, STT preset), not
    // just the settings panel. Product mode arrives over async IPC, but it starts
    // out non-NVIDIA, so nothing offered is ever briefly missing — the correction
    // only ever runs on real news.
    watch(
      [offeredSttEngines, selectedSttEngine],
      () => {
        if (!offeredSttEngines.value.includes(selectedSttEngine.value)) {
          selectedSttEngine.value = preferredSttEngine.value
        }
      },
      { immediate: true },
    )

    /**
     * Ensure the standalone Whisper sidecar is ready: its backend must be installed,
     * the selected model present (prompting the download popup if missing), and the
     * service running. Reports whether a download popup was shown — see
     * `SttReadyResult`.
     */
    async function ensureStandaloneReady(): Promise<SttReadyResult> {
      const svc = backendServices.info.find((s) => s.serviceName === 'whisper-backend')
      if (!svc?.isSetUp) {
        throw new Error(
          'The standalone Whisper backend is not installed. Install it from ' +
            'Settings → Installation Management, then try again.',
        )
      }
      let downloadPrompted = false
      const modelExists = await models.checkTranscriptionModelExists(selectedStandaloneModel.value)
      if (!modelExists) {
        const missing = await models.getMissingTranscriptionModel(selectedStandaloneModel.value)
        if (missing.length > 0) {
          downloadPrompted = true
          await new Promise<void>((resolve, reject) => {
            dialogStore.showDownloadDialog(
              missing,
              () => resolve(),
              () => reject(new Error('Whisper model download was cancelled')),
            )
          })
        }
      }
      // Re-read the service: the download popup above can take minutes, during
      // which serviceInfoUpdate may have changed the status (or the user may have
      // stopped/started it), making the captured `svc` snapshot stale.
      const current = backendServices.info.find((s) => s.serviceName === 'whisper-backend') ?? svc
      if (current.status !== 'running') {
        await backendServices.startService('whisper-backend')
      }
      standaloneModelPresent.value = true
      return { downloadPrompted }
    }

    /**
     * Dialog-free variant of {@link ensureStandaloneReady} for unattended paths
     * (the Home Agent's remote voice notes): start the sidecar if it is installed
     * and its model is already on disk, and otherwise do nothing. Never prompts —
     * a remote sender cannot answer a download popup on the host.
     */
    async function ensureStandaloneServerRunning(): Promise<void> {
      const svc = backendServices.info.find((s) => s.serviceName === 'whisper-backend')
      if (!svc?.isSetUp) return
      try {
        const modelExists = await models.checkTranscriptionModelExists(
          selectedStandaloneModel.value,
        )
        if (!modelExists) return
        // Re-read after the await, for the same reason as in ensureStandaloneReady.
        const current = backendServices.info.find((s) => s.serviceName === 'whisper-backend') ?? svc
        if (current.status !== 'running') {
          await backendServices.startService('whisper-backend')
        }
      } catch (error) {
        console.error('Failed to ensure the standalone Whisper sidecar is running:', error)
      }
    }

    /** OpenAI-compatible endpoint for the standalone Whisper sidecar, or null when
     *  its backend isn't running yet. The loopback token is passed as the apiKey so
     *  the shared transcribe helper's `Authorization: Bearer` satisfies the sidecar. */
    async function resolveStandaloneEndpoint(): Promise<TranscriptionEndpoint | null> {
      const svc = backendServices.info.find((s) => s.serviceName === 'whisper-backend')
      const baseUrl = svc?.baseUrl
      if (!baseUrl) return null
      const token = await window.electronAPI.getBackendAuthToken('whisper-backend')
      return {
        baseURL: `${baseUrl.replace(/\/$/, '')}/v1`,
        model: selectedStandaloneModel.value,
        apiKey: token ?? '',
      }
    }

    async function resolveStandaloneEndpointIfReady(): Promise<TranscriptionEndpoint | null> {
      const svc = backendServices.info.find((s) => s.serviceName === 'whisper-backend')
      if (!svc?.isSetUp || svc.status !== 'running') return null
      try {
        const modelExists = await models.checkTranscriptionModelExists(
          selectedStandaloneModel.value,
        )
        if (!modelExists) return null
      } catch {
        return null
      }
      return resolveStandaloneEndpoint()
    }

    /**
     * Ensure the OVMS Whisper server is ready to transcribe: OpenVINO must be set up
     * (or a fallback is configured), the model must be present (prompting the
     * standard download popup if missing), and the server must be running. Used by
     * the interactive STT paths (STT preset, mic, transcribeAudio tool) independent
     * of any enable toggle. Reports whether a download popup was shown — see
     * `SttReadyResult`.
     */
    async function ensureWhisperReady(): Promise<SttReadyResult> {
      const openVinoService = backendServices.info.find((s) => s.serviceName === 'openvino-backend')
      if (!openVinoService?.isSetUp) {
        // No OVMS: the fallback endpoint (if any) serves transcription directly.
        if (hasFallback()) return { downloadPrompted: false }
        throw new Error(
          'OpenVINO backend is required for Speech To Text. Install it from ' +
            'Settings → Installation Management, or configure a fallback endpoint.',
        )
      }

      const model = selectedOvmsModel.value
      let downloadPrompted = false
      const modelExists = await models.checkTranscriptionModelExists(model)
      if (!modelExists) {
        const missing = await models.getMissingTranscriptionModel(model)
        if (missing.length > 0) {
          downloadPrompted = true
          await new Promise<void>((resolve, reject) => {
            dialogStore.showDownloadDialog(
              missing,
              () => resolve(),
              () => reject(new Error('Whisper model download was cancelled')),
            )
          })
        }
      }

      // Always ask for the selected model rather than skipping when *some* server
      // is up: the model is picked per launch, so a server left running with the
      // previously selected model would otherwise keep serving it. The backend
      // no-ops when the running model already matches and restarts when it doesn't.
      await backendServices.startTranscriptionServer(model)
      return { downloadPrompted }
    }

    /**
     * Resolve which transcription endpoint to use. Prefers the OVMS Whisper
     * server when it is running, otherwise falls back to the configured
     * OpenAI-compatible endpoint. Returns `null` when neither is available.
     */
    async function resolveTranscription(): Promise<TranscriptionEndpoint | null> {
      // `effectiveSttEngine`, not the raw selection: the engine that was readied
      // and recorded against must be the one we transcribe with.
      const engine = effectiveSttEngine.value
      // Standalone only when the sidecar can actually serve: installed-without-
      // its-model would otherwise return the sidecar URL and skip a configured
      // external fallback (Home Agent's dialog-free path never prompts a download).
      if (engine === 'standalone') {
        const endpoint = await resolveStandaloneEndpointIfReady()
        if (endpoint) return endpoint
      } else if (engine !== 'external') {
        // Prefer the OVMS Whisper server when running; otherwise fall through.
        try {
          const ovmsUrl = await backendServices.getTranscriptionServerUrl()
          if (ovmsUrl) {
            return {
              baseURL: ovmsUrl,
              model: selectedOvmsModel.value.split('/').join('---'),
              apiKey: '',
            }
          }
        } catch (error) {
          console.error('Failed to resolve OVMS transcription server URL:', error)
        }
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
      // The external endpoint transcribes remotely, so there is no OVMS server to
      // start — and trying anyway is what used to break STT on hosts where OVMS is
      // installed but cannot execute (macOS, where its binary is not executable).
      if (effectiveSttEngine.value === 'external') return

      const openVinoService = backendServices.info.find((s) => s.serviceName === 'openvino-backend')

      // Only start if OVMS is set up. When OVMS is unavailable but a fallback
      // endpoint is configured, transcription is served by the fallback so
      // there is nothing to start here.
      if (!openVinoService?.isSetUp) return

      const model = selectedOvmsModel.value
      const modelExists = await models.checkTranscriptionModelExists(model)
      if (!modelExists) return

      try {
        // Idempotent for the model already being served; restarts on a switch.
        await backendServices.startTranscriptionServer(model)
      } catch (error) {
        console.error('Failed to ensure transcription server is running:', error)
      }
    }

    /**
     * Restore the backend/model choices to their defaults, for the Audio mode's
     * "Reset Preset Settings". Like the TTS side, the external endpoint's URL, model
     * and API key survive: they're machine configuration entered once, not a
     * per-preset choice, and a reset button offers no way back from wiping a key.
     *
     * The engine falls back to whatever is actually offered on this machine, so a
     * reset can't select an engine that isn't available here (the default is the
     * OpenVINO one, which NVIDIA mode doesn't have).
     */
    function resetToDefaults(): void {
      selectedStandaloneModel.value = DEFAULT_WHISPER_STANDALONE_MODEL
      selectedOvmsModel.value = DEFAULT_WHISPER_OVMS_MODEL
      const offered = offeredSttEngines.value
      selectedSttEngine.value = offered.includes('whisper') ? 'whisper' : (offered[0] ?? 'whisper')
    }

    /**
     * Validate STT prerequisites on app startup if STT is enabled.
     * Does not start the transcription server — that happens on first mic / transcribe.
     */
    async function initialize(): Promise<void> {
      if (productMode.isNvidiaModeSelected) {
        enabled.value = false
        return
      }

      if (!enabled.value) return

      // Nothing local to validate when the external endpoint is the source.
      if (effectiveSttEngine.value === 'external') return

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
        const modelExists = await models.checkTranscriptionModelExists(selectedOvmsModel.value)
        if (!modelExists) {
          enabled.value = false
          toast.warning('Speech To Text disabled: Whisper model not found')
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
        const model = selectedOvmsModel.value
        const modelExists = await models.checkTranscriptionModelExists(model)

        if (!modelExists) {
          // Show download dialog
          const missingModels = await models.getMissingTranscriptionModel(model)
          if (missingModels.length > 0) {
            dialogStore.showDownloadDialog(
              missingModels,
              async () => {
                // Model downloaded, start transcription server
                try {
                  await backendServices.startTranscriptionServer(model)
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
          await backendServices.startTranscriptionServer(model)
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
      selectedSttEngine,
      selectedStandaloneModel,
      selectedOvmsModel,
      isWhisperAvailable,
      isStandaloneAvailable,
      isExternalAvailable,
      available,
      // The engine every transcription path should dispatch on; `selectedSttEngine`
      // is the user's preference and may name an engine that is not installed.
      effectiveSttEngine,
      // Exposed so consumers (SettingsStt's engine dropdown) can render the offered
      // engines from the single source of truth instead of restating the rules.
      offeredSttEngines,
      hasFallback,
      resolveTranscription,
      ensureStandaloneReady,
      ensureStandaloneServerRunning,
      toggle,
      resetToDefaults,
      initialize,
      ensureTranscriptionServerRunning,
      ensureWhisperReady,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [
        'enabled',
        'fallback',
        'selectedSttEngine',
        'selectedStandaloneModel',
        'selectedOvmsModel',
      ],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSpeechToText, import.meta.hot))
}
