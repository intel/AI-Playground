import { defineStore } from 'pinia'
import { ref } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import { useDialogStore } from './dialogs'
import * as toast from '@/assets/js/toast'
import { qwen3TtsFetch } from '@/lib/loopbackAuth'
import { QWEN3_TTS_MODEL_REPOS } from '@/assets/js/qwen3TtsConstants'
import type {
  Qwen3TtsApiResponse,
  Qwen3TtsLanguage,
  Qwen3TtsSavedVoice,
  Qwen3TtsSpeakerId,
  Qwen3TtsSynthesisMode,
  Qwen3TtsSynthesizeResult,
} from '@/assets/js/qwen3TtsConstants'

export const useQwen3TextToSpeech = defineStore(
  'qwen3TextToSpeech',
  () => {
    const backendServices = useBackendServices()

    /** Default voice when the agent omits `speaker`. User can change in settings or chat. */
    const defaultSpeaker = ref<Qwen3TtsSpeakerId>('Ryan')
    const defaultLanguage = ref<Qwen3TtsLanguage>('Auto')
    /** `voice_design` uses natural-language voice descriptions via `instruct`. */
    const defaultMode = ref<Qwen3TtsSynthesisMode>('custom_voice')
    /** Free-form voice description used when `mode === 'voice_design'` and no per-call
     *  `instruct` is supplied (e.g. the direct-synthesis TTS preset). */
    const defaultInstruct = ref<string>('')

    /** User-created named voice directions, reusable from settings, chat, and the agent. */
    const savedVoices = ref<Qwen3TtsSavedVoice[]>([])

    /** The HF repo backing a synthesis mode. Each mode has its own weights, so we
     *  only prompt to download the one the user is actually about to use. */
    function modelRepoForMode(mode: Qwen3TtsSynthesisMode): string {
      return mode === 'voice_design'
        ? QWEN3_TTS_MODEL_REPOS.voiceDesign
        : QWEN3_TTS_MODEL_REPOS.customVoice
    }

    /** Whether the weights for a mode are present on disk (defaults to the current mode). */
    async function isModelInstalled(
      mode: Qwen3TtsSynthesisMode = defaultMode.value,
    ): Promise<boolean> {
      const models = useModels()
      return models.checkQwenTtsModelExists(modelRepoForMode(mode))
    }

    /**
     * Ensure the weights for a specific mode are downloaded, prompting the standard
     * model-download popup only when that mode's model is missing. Custom-voice and
     * voice-design are separate models, so creating a designed voice never pulls the
     * custom-voice model and vice-versa. Resolves once installed; rejects if the user
     * cancels or the download fails.
     */
    async function ensureModelInstalled(
      mode: Qwen3TtsSynthesisMode = defaultMode.value,
    ): Promise<void> {
      const models = useModels()
      const dialogs = useDialogStore()
      const missing = await models.getMissingQwenTtsModels([modelRepoForMode(mode)])
      if (missing.length === 0) return
      await new Promise<void>((resolve, reject) => {
        dialogs.showDownloadDialog(
          missing,
          () => resolve(),
          (reason) =>
            reject(
              reason instanceof Error
                ? reason
                : new Error('Text To Speech model download was cancelled'),
            ),
        )
      })
      // If the service was already running (e.g. started from the device picker
      // before the model existed), restart it so it picks up the freshly
      // downloaded weights via QWEN3_TTS_MODEL on the next spawn.
      const info = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      if (info?.status === 'running') {
        await backendServices.stopService('qwen3-tts-backend')
        await backendServices.startService('qwen3-tts-backend')
      }
    }

    async function ensureBackendRunning(): Promise<string> {
      const info = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      if (!info?.isSetUp) {
        throw new Error(
          'Text To Speech is not installed. Install it from Settings → Installation Management, then try again.',
        )
      }
      // Note: the per-mode model download is handled by ensureModelInstalled(mode),
      // called by ensureModelLoaded()/synthesize() so we only fetch the model the
      // user actually needs — not both. Starting the service does not download.
      if (info.status !== 'running') {
        await backendServices.startService('qwen3-tts-backend')
      }
      const running = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      const baseUrl = running?.baseUrl
      if (!baseUrl) {
        throw new Error('Text To Speech backend URL is not available')
      }
      return baseUrl.replace(/\/$/, '')
    }

    /**
     * Whether the model for a mode is already resident in the running backend, so
     * the caller can skip the "loading model" status phase when it would be a no-op.
     * Returns false (i.e. "will need loading") if the backend isn't running yet.
     */
    async function isModelLoaded(mode?: Qwen3TtsSynthesisMode): Promise<boolean> {
      const info = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      if (!info?.isSetUp || info.status !== 'running' || !info.baseUrl) return false
      try {
        const baseUrl = info.baseUrl.replace(/\/$/, '')
        const response = await qwen3TtsFetch(`${baseUrl}/api/config`, { method: 'GET' })
        const payload = (await response.json()) as Qwen3TtsApiResponse<{
          customVoiceModel: string
          voiceDesignModel: string
          status: { loadedModelIds: string[] }
        }>
        const data = payload.data
        if (!data) return false
        const targetId =
          (mode ?? defaultMode.value) === 'voice_design'
            ? data.voiceDesignModel
            : data.customVoiceModel
        return data.status.loadedModelIds.includes(targetId)
      } catch {
        return false
      }
    }

    /**
     * Ask the backend to load the model for a mode (without generating). Lets the
     * caller show a distinct "loading model" phase before "generating audio".
     */
    async function ensureModelLoaded(mode?: Qwen3TtsSynthesisMode): Promise<void> {
      const m = mode ?? defaultMode.value
      // Only prompt for the model this mode needs.
      await ensureModelInstalled(m)
      const baseUrl = await ensureBackendRunning()
      const response = await qwen3TtsFetch(`${baseUrl}/api/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: m }),
      })
      const payload = (await response.json()) as Qwen3TtsApiResponse<unknown>
      if (!response.ok || payload.code !== 0) {
        throw new Error(
          payload.message ?? `Failed to load Text To Speech model (${response.status})`,
        )
      }
    }

    async function synthesize(args: {
      text: string
      language?: Qwen3TtsLanguage
      speaker?: Qwen3TtsSpeakerId
      instruct?: string
      mode?: Qwen3TtsSynthesisMode
      /** Name of a saved voice; overrides mode/instruct with the saved description. */
      voiceName?: string
    }): Promise<Qwen3TtsSynthesizeResult> {
      let mode = args.mode ?? defaultMode.value
      let language = args.language ?? defaultLanguage.value
      let instruct = args.instruct
      const speaker = args.speaker ?? defaultSpeaker.value
      // A named voice is a saved voice_design description; it wins over mode/instruct.
      if (args.voiceName) {
        const saved = resolveVoice(args.voiceName)
        if (!saved) {
          throw new Error(`No saved Text To Speech voice named "${args.voiceName}"`)
        }
        mode = 'voice_design'
        instruct = saved.instruct
        if (saved.language) language = saved.language
      }
      // Only the model for the resolved mode is required.
      await ensureModelInstalled(mode)
      const baseUrl = await ensureBackendRunning()
      const body = {
        text: args.text,
        language,
        speaker,
        // For voice_design fall back to the saved description when the caller omits one.
        instruct: instruct ?? (mode === 'voice_design' ? defaultInstruct.value : undefined),
        mode,
      }
      const response = await qwen3TtsFetch(`${baseUrl}/api/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await response.json()) as Qwen3TtsApiResponse<Qwen3TtsSynthesizeResult>
      if (!response.ok || payload.code !== 0 || !payload.data) {
        throw new Error(payload.message ?? `Text To Speech synthesis failed (${response.status})`)
      }
      return payload.data
    }

    /** Persist WAV bytes under Documents/AI-Playground/audio and return the absolute path. */
    async function saveWavToDisk(audioBase64: string, suggestedName: string): Promise<string> {
      const result = await window.electronAPI.saveGeneratedAudio(audioBase64, suggestedName)
      if (!result.success || !result.filePath) {
        throw new Error(result.error ?? 'Failed to save audio file')
      }
      return result.filePath
    }

    function isBackendSetUp(): boolean {
      return (
        backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')?.isSetUp === true
      )
    }

    async function applyUserVoicePreference(args: {
      speaker?: Qwen3TtsSpeakerId
      language?: Qwen3TtsLanguage
      mode?: Qwen3TtsSynthesisMode
    }): Promise<void> {
      if (args.speaker) defaultSpeaker.value = args.speaker
      if (args.language) defaultLanguage.value = args.language
      if (args.mode) defaultMode.value = args.mode
      toast.success('Updated default Text To Speech voice settings for this session')
    }

    /** Create or update a named voice direction (matched case-insensitively by name). */
    function saveVoice(voice: Qwen3TtsSavedVoice): void {
      const name = voice.name.trim()
      const instruct = voice.instruct.trim()
      if (!name || !instruct) return
      const entry: Qwen3TtsSavedVoice = { name, instruct, language: voice.language }
      const idx = savedVoices.value.findIndex((v) => v.name.toLowerCase() === name.toLowerCase())
      if (idx >= 0) savedVoices.value.splice(idx, 1, entry)
      else savedVoices.value.push(entry)
    }

    function deleteVoice(name: string): void {
      savedVoices.value = savedVoices.value.filter(
        (v) => v.name.toLowerCase() !== name.trim().toLowerCase(),
      )
    }

    function resolveVoice(name: string): Qwen3TtsSavedVoice | undefined {
      const n = name.trim().toLowerCase()
      return savedVoices.value.find((v) => v.name.toLowerCase() === n)
    }

    /** Mirrors `isQwen3TtsEnabled` from settings.json (dev: settings-dev.json). */
    const isFeatureEnabled = ref(false)

    async function initFeatureFlag() {
      try {
        const localSettings = await window.electronAPI.getLocalSettings()
        isFeatureEnabled.value = !!localSettings.isQwen3TtsEnabled
      } catch (e) {
        console.error('qwen3TextToSpeech.initFeatureFlag failed:', e)
        isFeatureEnabled.value = false
      }
    }
    void initFeatureFlag()

    return {
      defaultSpeaker,
      defaultLanguage,
      defaultMode,
      defaultInstruct,
      savedVoices,
      isFeatureEnabled,
      synthesize,
      saveWavToDisk,
      ensureBackendRunning,
      ensureModelInstalled,
      ensureModelLoaded,
      isModelLoaded,
      isModelInstalled,
      isBackendSetUp,
      applyUserVoicePreference,
      saveVoice,
      deleteVoice,
      resolveVoice,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['defaultSpeaker', 'defaultLanguage', 'defaultMode', 'defaultInstruct', 'savedVoices'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useQwen3TextToSpeech, import.meta.hot))
}
